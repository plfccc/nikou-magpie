package nikou

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	"github.com/yetone/magpie/internal/filelock"
	"github.com/yetone/magpie/internal/steady"
)

const receiptTTL = 24 * time.Hour

type accountReceipt struct {
	Hash      string    `json:"hash"`
	CreatedAt time.Time `json:"createdAt"`
	Reply     *Reply    `json:"reply,omitempty"`
}

// HandleAccountWithReceipts 在所有桥接进程间串行执行账号写操作，并保留可确认的结果。
func HandleAccountWithReceipts(ctx context.Context, req AccountRequest, service *AccountService, path string) Reply {
	return handleAccountWithReceipts(ctx, req, service, path, 10*time.Second)
}

func handleAccountWithReceipts(ctx context.Context, req AccountRequest, service *AccountService, path string, lockWait time.Duration) Reply {
	if req.Protocol != Protocol || !safeID.MatchString(req.RequestID) {
		return Failure(req.RequestID, "INVALID_REQUEST", "桥接协议或请求 ID 无效", false)
	}
	if req.Engine != "codex" && req.Engine != "claude" {
		return Failure(req.RequestID, "CAPABILITY_UNSUPPORTED", "当前版本仅支持 Codex 与 Claude 的原生账号", false)
	}
	if req.Op != "accounts.list" && req.Op != "accounts.select" && req.Op != "accounts.refresh" {
		return Failure(req.RequestID, "INVALID_REQUEST", "账号操作不受支持", false)
	}
	if req.Op == "accounts.list" {
		return service.Handle(ctx, req)
	}
	if ref := req.AccountRef; ref == nil || ref.Engine != req.Engine || ref.ProviderID != req.Engine || ref.AccountID == "" {
		return Failure(req.RequestID, "INVALID_ACCOUNT_REF", "账号引用与引擎不匹配", false)
	}
	unknown := func() Reply {
		return Failure(req.RequestID, "OPERATION_UNKNOWN", "账号操作结果尚未确认，请重新查询账号状态，不要自动重放操作", false)
	}
	if err := ctx.Err(); err != nil {
		return Failure(req.RequestID, "BRIDGE_UNAVAILABLE", "账号桥接请求已取消", false)
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < lockWait {
		lockWait = time.Until(deadline)
	}
	unlock, held := filelock.Lock(path+".lock", lockWait)
	defer unlock()
	if !held {
		return Failure(req.RequestID, "BRIDGE_BUSY", "账号桥接暂时不可用，请稍后使用相同请求 ID 查询或重试", true)
	}
	if ctx.Err() != nil {
		return Failure(req.RequestID, "BRIDGE_UNAVAILABLE", "账号桥接请求已取消", false)
	}
	receipts, err := readAccountReceipts(path)
	if err != nil {
		return unknown()
	}
	raw, _ := json.Marshal(req)
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	now := time.Now().UTC()
	for id, receipt := range receipts {
		// 中断后留下的 pending 不自动过期，否则旧请求可能再次产生副作用。
		if receipt.Reply != nil && now.Sub(receipt.CreatedAt) >= receiptTTL {
			delete(receipts, id)
		}
	}
	if previous, ok := receipts[req.RequestID]; ok {
		if previous.Hash != hash {
			return Failure(req.RequestID, "REQUEST_ID_CONFLICT", "请求 ID 已用于不同的账号操作", false)
		}
		if previous.Reply == nil {
			return unknown()
		}
		return *previous.Reply
	}
	receipt := accountReceipt{Hash: hash, CreatedAt: now}
	receipts[req.RequestID] = receipt
	if err := writeAccountReceipts(path, receipts); err != nil {
		return Failure(req.RequestID, "RECEIPT_UNAVAILABLE", "无法持久保存操作回执，账号操作未执行", false)
	}
	reply := service.Handle(ctx, req)
	receipt.Reply = &reply
	receipts[req.RequestID] = receipt
	if err := writeAccountReceipts(path, receipts); err != nil {
		return unknown()
	}
	return reply
}

func readAccountReceipts(path string) (map[string]accountReceipt, error) {
	receipts := make(map[string]accountReceipt)
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return receipts, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	const maxReceiptsBytes = 8 << 20
	raw, err := io.ReadAll(io.LimitReader(f, maxReceiptsBytes+1))
	if err != nil || len(raw) > maxReceiptsBytes {
		return nil, errors.New("操作回执无法读取或超过大小限制")
	}
	if err := json.Unmarshal(raw, &receipts); err != nil || receipts == nil {
		return nil, errors.New("操作回执格式无效")
	}
	for id, r := range receipts {
		if !safeID.MatchString(id) || len(r.Hash) != sha256.Size*2 || r.CreatedAt.IsZero() || (r.Reply != nil && (r.Reply.Protocol != Protocol || r.Reply.RequestID != id || (r.Reply.OK && r.Reply.Data == nil) || (!r.Reply.OK && r.Reply.Error == nil))) {
			return nil, errors.New("操作回执内容无效")
		}
	}
	return receipts, nil
}

func writeAccountReceipts(path string, receipts map[string]accountReceipt) error {
	raw, err := json.Marshal(receipts)
	if err != nil {
		return err
	}
	return steady.WriteFile(path, raw, 0600)
}
