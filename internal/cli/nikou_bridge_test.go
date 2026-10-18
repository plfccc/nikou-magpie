package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/nikou"
	"github.com/yetone/magpie/internal/provider"
)

func TestNikouBridgeInvalidInputAndUnsupportedEngine(t *testing.T) {
	for _, input := range []string{`bad`, `{"protocol":1,"requestId":"request-1","op":"accounts.list","engine":"kiro"}`} {
		var out bytes.Buffer
		if err := nikouBridge(strings.NewReader(input), &out, nil); err != nil {
			t.Fatal(err)
		}
		var reply nikou.Reply
		if err := json.Unmarshal(out.Bytes(), &reply); err != nil || reply.OK || reply.Error == nil {
			t.Fatalf("不合法响应：%s %v", out.String(), err)
		}
	}
}

func TestNikouBridgeWritesHavePersistentReceipts(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	calls := 0
	s := &nikou.AccountService{
		List:    func(string) []provider.Login { return []provider.Login{{User: "receipt@example.test"}} },
		ID:      func(string, string) string { return "account-id" },
		Quotas:  func(time.Time) []provider.Quota { return nil },
		Switch:  func(string, string) error { calls++; return nil },
		Refresh: func(context.Context, string, string, time.Time) []provider.Quota { return nil },
	}
	input := `{"protocol":1,"requestId":"persistent-select","op":"accounts.select","engine":"codex","accountRef":{"engine":"codex","providerId":"codex","accountId":"account-id"}}`
	for i := 0; i < 2; i++ {
		var out bytes.Buffer
		if err := nikouBridge(strings.NewReader(input), &out, s); err != nil {
			t.Fatal(err)
		}
		var reply nikou.Reply
		if err := json.Unmarshal(out.Bytes(), &reply); err != nil || !reply.OK {
			t.Fatalf("桥接失败：%s %v", out.String(), err)
		}
	}
	if calls != 1 {
		t.Fatalf("重复请求重放账号切换：%d", calls)
	}
}

func TestNikouSelfCheckDoesNotInitializeUserState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	var out bytes.Buffer
	if err := nikouSelfCheck(&out); err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(out.Bytes(), &data); err != nil || data["ok"] != true || data["component"] != "magpie" {
		t.Fatalf("自检结果无效：%s", out.String())
	}
	if entries, err := os.ReadDir(home); err != nil || len(entries) != 0 {
		t.Fatalf("自检创建了用户状态：%v %v", entries, err)
	}
}
