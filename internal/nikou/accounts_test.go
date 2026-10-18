package nikou

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

func fakeAccounts() *AccountService {
	return &AccountService{
		List: func(engine string) []provider.Login {
			return []provider.Login{{Agent: engine, User: "one@example.test", Active: true}, {Agent: engine, User: "two@example.test"}}
		},
		ID: func(engine, user string) string { return "stable-" + user },
		Quotas: func(time.Time) []provider.Quota {
			return []provider.Quota{{Provider: "codex", User: "one@example.test", Alias: "同名", Windows: []provider.QuotaSpan{{Name: "5h", Remaining: 50}}}}
		},
		Switch: func(string, string) error { return nil },
		Refresh: func(context.Context, string, string, time.Time) []provider.Quota {
			return []provider.Quota{{Provider: "codex", User: "one@example.test"}}
		},
	}
}

func TestNikouAccountStableReference(t *testing.T) {
	s := fakeAccounts()
	r := s.Handle(context.Background(), AccountRequest{Protocol: 1, RequestID: "list-1", Op: "accounts.list", Engine: "codex"})
	if !r.OK {
		t.Fatal(r.Error)
	}
	data := r.Data.(AccountList)
	if len(data.Profiles) != 2 || data.Profiles[0].ID == data.Profiles[1].ID || data.CurrentAlias != "同名" {
		t.Fatalf("错误账号映射：%+v", data)
	}
	ref, err := DecodeAccountRef(data.Profiles[0].ID)
	if err != nil || ref.AccountID != "stable-one@example.test" || ref.ProviderID != "codex" {
		t.Fatalf("引用不稳定：%+v %v", ref, err)
	}
	selected := s.Handle(context.Background(), AccountRequest{Protocol: 1, RequestID: "select-1", Op: "accounts.select", Engine: "codex", AccountRef: &ref})
	if !selected.OK {
		t.Fatal(selected.Error)
	}
}

func TestNikouAccountRejectsStaleOrUnsupportedIdentity(t *testing.T) {
	s := fakeAccounts()
	calls := 0
	s.Switch = func(string, string) error { calls++; return nil }
	for _, engine := range []string{"kiro", "api", "claude"} {
		ref := AccountRef{Engine: engine, ProviderID: engine, AccountID: "missing"}
		got := s.Handle(context.Background(), AccountRequest{Protocol: 1, RequestID: "stale-1", Op: "accounts.select", Engine: engine, AccountRef: &ref})
		if got.OK {
			t.Fatal("接受不存在的账号")
		}
	}
	if calls != 0 {
		t.Fatal("无效账号触发切换")
	}
}

func TestNikouAccountRefreshFailureDoesNotBecomeSuccess(t *testing.T) {
	s := fakeAccounts()
	s.Refresh = func(context.Context, string, string, time.Time) []provider.Quota {
		return []provider.Quota{{Provider: "codex", User: "one@example.test", Error: "upstream refused secret payload"}}
	}
	ref := AccountRef{Engine: "codex", ProviderID: "codex", AccountID: "stable-one@example.test"}
	got := s.Handle(context.Background(), AccountRequest{Protocol: 1, RequestID: "refresh-1", Op: "accounts.refresh", Engine: "codex", AccountRef: &ref})
	if got.OK || got.Error.Message == "upstream refused secret payload" {
		t.Fatal("错误刷新结果")
	}
}

func TestNikouAccountRefreshCachedFallbackIsStale(t *testing.T) {
	s := fakeAccounts()
	previous := time.Now().Add(-time.Hour)
	s.Refresh = func(context.Context, string, string, time.Time) []provider.Quota {
		return []provider.Quota{{Provider: "codex", User: "one@example.test", AsOf: &previous}}
	}
	ref := AccountRef{Engine: "codex", ProviderID: "codex", AccountID: "stable-one@example.test"}
	got := s.Handle(context.Background(), AccountRequest{Protocol: 1, RequestID: "refresh-stale", Op: "accounts.refresh", Engine: "codex", AccountRef: &ref})
	if got.OK || got.Error == nil || got.Error.Code != "QUOTA_REFRESH_FAILED" {
		t.Fatalf("旧快照不能冒充刷新成功：%+v", got)
	}
}

func TestNikouAccountRefFixtureAndInvalidInput(t *testing.T) {
	ref := AccountRef{Engine: "codex", ProviderID: "provider-1", AccountID: "account-1"}
	id := EncodeAccountRef(ref)
	if id != "eyJlbmdpbmUiOiJjb2RleCIsInByb3ZpZGVySWQiOiJwcm92aWRlci0xIiwiYWNjb3VudElkIjoiYWNjb3VudC0xIn0" {
		t.Fatal(id)
	}
	for _, bad := range []string{"not-json", id + "=", "", "e30"} {
		if _, err := DecodeAccountRef(bad); err == nil {
			t.Error(bad)
		}
	}
	raw, _ := json.Marshal(fakeAccounts().Handle(context.Background(), AccountRequest{Protocol: 2, RequestID: "req-1", Op: "accounts.list", Engine: "codex"}))
	var r Reply
	json.Unmarshal(raw, &r)
	if r.OK || r.Error == nil {
		t.Fatal(string(raw))
	}
}
