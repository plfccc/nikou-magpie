package nikou

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/filelock"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/steady"
)

func receiptRequest() AccountRequest {
	return AccountRequest{Protocol: Protocol, RequestID: "receipt-write", Op: "accounts.select", Engine: "codex", AccountRef: &AccountRef{Engine: "codex", ProviderID: "codex", AccountID: "stable-one@example.test"}}
}

func TestAccountReceiptsReplayConflictAndPending(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations.json")
	s := fakeAccounts()
	calls := 0
	s.Switch = func(string, string) error { calls++; return nil }
	req := receiptRequest()
	for i := 0; i < 2; i++ {
		if got := HandleAccountWithReceipts(context.Background(), req, s, path); !got.OK {
			t.Fatal(got.Error)
		}
	}
	if calls != 1 {
		t.Fatalf("账号写操作被重放：%d", calls)
	}
	req.Op = "accounts.refresh"
	if got := HandleAccountWithReceipts(context.Background(), req, s, path); got.OK || got.Error.Code != "REQUEST_ID_CONFLICT" {
		t.Fatalf("请求 ID 冲突未拒绝：%+v", got)
	}
	receipts, err := readAccountReceipts(path)
	if err != nil {
		t.Fatal(err)
	}
	previous := receipts[req.RequestID]
	previous.Reply = nil
	previous.CreatedAt = time.Now().Add(-48 * time.Hour)
	receipts[req.RequestID] = previous
	if err := writeAccountReceipts(path, receipts); err != nil {
		t.Fatal(err)
	}
	req.Op = "accounts.select"
	if got := HandleAccountWithReceipts(context.Background(), req, s, path); got.OK || got.Error.Code != "OPERATION_UNKNOWN" || calls != 1 {
		t.Fatalf("pending 被重放：%+v 次数=%d", got, calls)
	}
}

func TestAccountReceiptsExpireConfirmedResultsAfter24Hours(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations.json")
	s := fakeAccounts()
	calls := 0
	s.Switch = func(string, string) error { calls++; return nil }
	req := receiptRequest()
	if got := HandleAccountWithReceipts(context.Background(), req, s, path); !got.OK {
		t.Fatal(got.Error)
	}
	receipts, _ := readAccountReceipts(path)
	r := receipts[req.RequestID]
	r.CreatedAt = time.Now().Add(-receiptTTL - time.Second)
	receipts[req.RequestID] = r
	if err := writeAccountReceipts(path, receipts); err != nil {
		t.Fatal(err)
	}
	if got := HandleAccountWithReceipts(context.Background(), req, s, path); !got.OK || calls != 2 {
		t.Fatalf("24 小时回执未过期：%+v 次数=%d", got, calls)
	}
}

func TestAccountReceiptValidationAndListCreateNoState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent", "operations.json")
	s := fakeAccounts()
	for _, req := range []AccountRequest{{Protocol: 2, RequestID: "invalid", Op: "accounts.select", Engine: "codex"}, {Protocol: 1, RequestID: "invalid", Op: "accounts.select", Engine: "kiro"}, {Protocol: 1, RequestID: "invalid", Op: "accounts.select", Engine: "codex"}, {Protocol: 1, RequestID: "invalid", Op: "other", Engine: "codex"}} {
		if got := HandleAccountWithReceipts(context.Background(), req, nil, path); got.OK {
			t.Fatal("无效请求被接受")
		}
	}
	req := receiptRequest()
	req.Op = "accounts.list"
	if got := HandleAccountWithReceipts(context.Background(), req, s, path); !got.OK {
		t.Fatal(got.Error)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatalf("只读/无效请求创建状态：%v", err)
	}
}

func TestAccountReceiptUnknownWhenStoreUnreadable(t *testing.T) {
	for _, raw := range []string{`{`, `null`, `[]`, `{"old":{}}`} {
		path := filepath.Join(t.TempDir(), "operations.json")
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		s := fakeAccounts()
		s.Switch = func(string, string) error { t.Fatal("损坏回执不能触发写入"); return nil }
		if got := HandleAccountWithReceipts(context.Background(), receiptRequest(), s, path); got.OK || got.Error.Code != "OPERATION_UNKNOWN" {
			t.Fatalf("未知状态被覆盖：%+v", got)
		}
		got, _ := os.ReadFile(path)
		if string(got) != raw {
			t.Fatal("损坏回执被覆盖")
		}
	}
}

func TestAccountReceiptsRequireHeldLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations.json")
	unlock, held := filelock.Lock(path+".lock", time.Second)
	if !held {
		t.Fatal("测试锁获取失败")
	}
	defer unlock()
	s := fakeAccounts()
	s.Switch = func(string, string) error { t.Fatal("未获得锁却修改账号"); return nil }
	got := handleAccountWithReceipts(context.Background(), receiptRequest(), s, path, 20*time.Millisecond)
	if got.OK || got.Error.Code != "BRIDGE_BUSY" {
		t.Fatalf("锁失败后继续操作：%+v", got)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("锁失败写入了回执：%v", err)
	}
}

func TestAccountReceiptsSerializeSelectAndRefresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations.json")
	s := fakeAccounts()
	entered, release := make(chan struct{}), make(chan struct{})
	s.Switch = func(string, string) error { close(entered); <-release; return nil }
	var refreshCalls atomic.Int32
	s.Refresh = func(context.Context, string, string, time.Time) []provider.Quota { refreshCalls.Add(1); return nil }
	done := make(chan Reply, 1)
	go func() { done <- HandleAccountWithReceipts(context.Background(), receiptRequest(), s, path) }()
	<-entered
	req := receiptRequest()
	req.RequestID, req.Op = "other-write", "accounts.refresh"
	got := handleAccountWithReceipts(context.Background(), req, s, path, 20*time.Millisecond)
	close(release)
	first := <-done
	if !first.OK || got.OK || got.Error.Code != "BRIDGE_BUSY" || refreshCalls.Load() != 0 {
		t.Fatalf("账号写操作没有串行：%+v %+v", first, got)
	}
}

func TestAccountReceiptAcrossProcesses(t *testing.T) {
	if path := os.Getenv("NIKOU_RECEIPT_TEST_PATH"); path != "" {
		s := fakeAccounts()
		s.Switch = func(string, string) error {
			f, err := os.OpenFile(path+".writes", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = f.WriteString("write\n")
			if err == nil && os.Getenv("NIKOU_RECEIPT_TEST_CRASH") == "1" {
				f.Close()
				os.Exit(0)
			}
			return err
		}
		if got := HandleAccountWithReceipts(context.Background(), receiptRequest(), s, path); !got.OK {
			t.Fatal(got.Error)
		}
		return
	}
	path := filepath.Join(t.TempDir(), "operations.json")
	commands := []*exec.Cmd{exec.Command(os.Args[0], "-test.run=^TestAccountReceiptAcrossProcesses$"), exec.Command(os.Args[0], "-test.run=^TestAccountReceiptAcrossProcesses$")}
	for _, cmd := range commands {
		cmd.Env = append(os.Environ(), "NIKOU_RECEIPT_TEST_PATH="+path)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if cmd.ProcessState == nil {
				cmd.Process.Kill()
				cmd.Wait()
			}
		})
	}
	for _, cmd := range commands {
		if err := cmd.Wait(); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path + ".writes")
	if err != nil || strings.Count(string(raw), "write\n") != 1 {
		t.Fatalf("跨进程重复写入：%q %v", raw, err)
	}
	raw, err = os.ReadFile(path)
	var saved map[string]json.RawMessage
	if err != nil || json.Unmarshal(raw, &saved) != nil || len(saved) != 1 {
		t.Fatalf("回执无效：%q %v", raw, err)
	}
}

func TestAccountReceiptInterruptedProcessIsNotReplayed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations.json")
	cmd := exec.Command(os.Args[0], "-test.run=^TestAccountReceiptAcrossProcesses$")
	cmd.Env = append(os.Environ(), "NIKOU_RECEIPT_TEST_PATH="+path, "NIKOU_RECEIPT_TEST_CRASH=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("中断进程失败：%s %v", out, err)
	}
	s := fakeAccounts()
	s.Switch = func(string, string) error { t.Fatal("进程中断后重放了账号操作"); return nil }
	if got := HandleAccountWithReceipts(context.Background(), receiptRequest(), s, path); got.OK || got.Error.Code != "OPERATION_UNKNOWN" {
		t.Fatalf("中断进程结果错误：%+v", got)
	}
	if raw, err := os.ReadFile(path + ".writes"); err != nil || string(raw) != "write\n" {
		t.Fatalf("中断前副作用未确认：%q %v", raw, err)
	}
}

func TestAccountReceiptCanceledRequestCreatesNoState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations.json")
	s := fakeAccounts()
	s.Switch = func(string, string) error {
		t.Fatal("取消请求触发账号操作")
		return nil
	}
	req := receiptRequest()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := HandleAccountWithReceipts(ctx, req, s, path); got.OK || got.Error.Code != "BRIDGE_UNAVAILABLE" {
		t.Fatalf("取消请求被执行：%+v", got)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("取消请求创建了回执")
	}
}

func TestAccountReceiptCompletionFlushFailureStaysUnknown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations.json")
	s := fakeAccounts()
	originalSync := steady.Sync
	t.Cleanup(func() { steady.Sync = originalSync })
	calls := 0
	s.Switch = func(string, string) error {
		calls++
		steady.Sync = func(*os.File) error { return errors.New("模拟回执刷盘失败") }
		return nil
	}
	req := receiptRequest()
	got := HandleAccountWithReceipts(context.Background(), req, s, path)
	steady.Sync = originalSync
	if got.OK || got.Error.Code != "OPERATION_UNKNOWN" {
		t.Fatalf("回执刷盘失败却确认成功：%+v", got)
	}
	if got := HandleAccountWithReceipts(context.Background(), req, s, path); got.OK || got.Error.Code != "OPERATION_UNKNOWN" || calls != 1 {
		t.Fatalf("未确认操作被重放：%+v 次数=%d", got, calls)
	}
}
