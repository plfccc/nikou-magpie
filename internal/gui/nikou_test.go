package gui

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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

func TestNikouGatewayConnectUsesManagedConnection(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	tokenPath := filepath.Join(home, ".nikou-block", "console", "token")
	if err := os.MkdirAll(filepath.Dir(tokenPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte("console-management-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(tokenPath) })
	writes := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Nikou-Request-Id")
		if r.Header.Get("X-Nikou-Console-Token") != "console-management-secret" {
			t.Error("管理鉴权丢失")
		}
		if r.URL.Path == "/api/integration/v1/hello" {
			json.NewEncoder(w).Encode(nikou.Success(id, nikou.Hello{Service: "nikou-console", Protocol: 1, InstanceID: "gateway-test", Capabilities: map[string]bool{"gatewayConnection": true}}))
			return
		}
		writes++
		if r.URL.Path != "/api/integration/v2/runtime/gateway" {
			t.Errorf("错误路径：%s", r.URL.Path)
		}
		var body struct {
			RequestID string `json:"requestId"`
			Confirmed bool   `json:"confirmed"`
			nikou.GatewayConnection
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.AgentToken != "magpie-nikou" || body.Origin == "http://evil.example" || body.RequestID != "managed-gateway" || !body.Confirmed {
			t.Errorf("未使用受管连接：%+v", body)
		}
		raw, _ := json.Marshal(body)
		if strings.Contains(string(raw), "console-management-secret") {
			t.Error("管理凭据泄露进推理配置")
		}
		json.NewEncoder(w).Encode(nikou.Success(id, map[string]any{"saved": true}))
	}))
	defer s.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(s.URL, "http://"))
	p, _ := strconv.Atoi(port)
	h := nikouHandler(&importWindows{}, func() (int, bool) { return p, true })
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest("POST", "/api/nikou/gateway/connect", strings.NewReader(`{"requestId":"managed-gateway","confirmed":true,"origin":"http://evil.example","agentToken":"console-management-secret"}`)))
	var reply nikou.Reply
	if err := json.Unmarshal(rec.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if !reply.OK || writes != 1 {
		t.Fatalf("受管接入失败：%s 次数=%d", rec.Body.String(), writes)
	}
}
