package cli

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/nikou"
)

func nikouBridge(input io.Reader, output io.Writer, service *nikou.AccountService) error {
	return nikouBridgeWithReceipts(input, output, service, "")
}

func nikouBridgeWithReceipts(input io.Reader, output io.Writer, service *nikou.AccountService, receiptPath string) error {
	bytes, err := io.ReadAll(io.LimitReader(input, 1<<20+1))
	var req nikou.AccountRequest
	var reply nikou.Reply
	if err != nil || len(bytes) > 1<<20 || json.Unmarshal(bytes, &req) != nil {
		reply = nikou.Failure("", "INVALID_REQUEST", "标准输入必须是大小受限的 JSON 请求", false)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
		defer cancel()
		if receiptPath == "" {
			receiptPath = filepath.Join(appdir.Config(), "nikou-bridge-operations.json")
		}
		reply = nikou.HandleAccountWithReceipts(ctx, req, service, receiptPath)
	}
	return json.NewEncoder(output).Encode(reply)
}

func nikouBridgeCmd(args []string) error {
	if len(args) != 0 {
		return json.NewEncoder(os.Stdout).Encode(nikou.Failure("", "INVALID_REQUEST", "账号桥接不接受命令行参数，请使用标准输入", false))
	}
	return nikouBridge(os.Stdin, os.Stdout, nikou.DefaultAccountService())
}
