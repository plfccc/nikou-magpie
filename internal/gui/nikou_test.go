package gui

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/nikou"
)

func TestNikouLocalRoutes(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		on   bool
		web  bool
		code string
	}{
		{"未确认", `{"requestId":"open-1"}`, true, false, "INVALID_REQUEST"},
		{"缺ID", `{"confirmed":true}`, true, false, "INVALID_REQUEST"},
		{"禁用", `{"requestId":"open-1","confirmed":true}`, false, false, "PLUGIN_DISABLED"},
		{"远程Web", `{"requestId":"open-1","confirmed":true}`, true, true, "LOCAL_DESKTOP_ONLY"},
		{"打开", `{"requestId":"open-1","confirmed":true}`, true, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			window := &importWindows{}
			var w Windows = window
			if tc.web {
				w = webHost{}
			}
			h := nikouHandler(w, func() (int, bool) { return 19736, tc.on })
			rec := httptest.NewRecorder()
			h(rec, httptest.NewRequest("POST", "/api/nikou/open", strings.NewReader(tc.body)))
			var reply nikou.Reply
			if err := json.Unmarshal(rec.Body.Bytes(), &reply); err != nil {
				t.Fatal(err)
			}
			if reply.Protocol != 1 || reply.RequestID == "" {
				t.Fatal(rec.Body.String())
			}
			if tc.code != "" {
				if reply.OK || reply.Error == nil || reply.Error.Code != tc.code {
					t.Fatal(rec.Body.String())
				}
				if window.opened != "" {
					t.Fatal("错误请求打开了浏览器")
				}
			} else if !reply.OK || reply.RequestID != "open-1" || window.opened != "http://127.0.0.1:19736/" {
				t.Fatal(rec.Body.String(), window.opened)
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("未禁止缓存")
			}
		})
	}
}

func TestNikouAssetsCheck(t *testing.T) {
	if err := NikouAssetsCheck(); err != nil {
		t.Fatal(err)
	}
}
