package nikou

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func TestGatewayConnectionKeepsCatalogUnverified(t *testing.T) {
	got, err := NewGatewayConnection("http://127.0.0.1:3425/", "magpie-nikou", []provider.Entry{
		{ID: "relay/known", Name: "已知模型", Context: 128000, Output: 8192, Reasoning: true, Efforts: []string{"low", "high"}},
		{ID: "relay/unknown"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "http://127.0.0.1:3425" || got.SessionHeader != "X-Magpie-Session" || len(got.Models) != 2 {
		t.Fatalf("连接错误：%+v", got)
	}
	if got.Models[0].Verified || got.Models[0].ContextWindow != 128000 || got.Models[0].MaxOutputTokens != 8192 || got.Models[0].Protocol != "openai-responses" {
		t.Fatalf("目录失真：%+v", got.Models[0])
	}
	raw, _ := json.Marshal(got.Models[1])
	if strings.Contains(string(raw), "contextWindow") || strings.Contains(string(raw), "maxOutputTokens") || strings.Contains(string(raw), "tools") || !strings.Contains(string(raw), `"supportedEfforts":[]`) {
		t.Fatalf("未知能力被编造：%s", raw)
	}
}

func TestGatewayConnectionRejectsUnmanagedOrigins(t *testing.T) {
	for _, origin := range []string{"http://example.com:3425", "http://127.0.0.1:3425/v1", "http://127.0.0.1:3425?x=1", "http://user@127.0.0.1:3425", "https://127.0.0.1:3425", "http://127.0.0.1", "http://0.0.0.0:3425", "http://127.0.0.2:3425"} {
		if _, err := NewGatewayConnection(origin, "magpie-nikou", nil); err == nil {
			t.Fatalf("接受不安全地址：%s", origin)
		}
	}
	if _, err := NewGatewayConnection("http://127.0.0.1:3425", "console-management-secret", nil); err == nil {
		t.Fatal("不应接受其他令牌作为推理来源标识")
	}
}

func TestGatewayConnectionPinsLocalhost(t *testing.T) {
	got, err := NewGatewayConnection("http://localhost:3425", "magpie-nikou", nil)
	if err != nil || got.Origin != "http://127.0.0.1:3425" {
		t.Fatalf("localhost未固定到回环IP：%+v %v", got, err)
	}
}

func TestGatewayConnectionCanonicalOrigin(t *testing.T) {
	for _, origin := range []string{"http://127.0.0.1:03425/", "http://[::ffff:127.0.0.1]:3425/"} {
		got, err := NewGatewayConnection(origin, "magpie-nikou", nil)
		if err != nil || got.Origin != "http://127.0.0.1:3425" {
			t.Fatalf("地址未规范化：%+v %v", got, err)
		}
	}
	for origin, want := range map[string]string{"http://127.0.0.1:80": "http://127.0.0.1", "http://[::1]:80": "http://[::1]"} {
		got, err := NewGatewayConnection(origin, "magpie-nikou", nil)
		if err != nil || got.Origin != want {
			t.Fatalf("默认端口未规范化：%+v %v", got, err)
		}
	}
}

func TestConsoleV2GatewayUsesSeparateCapability(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		writes := 0
		c := testConsole(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/integration/v1/hello" {
				answer(w, r, Hello{Service: "nikou-console", Protocol: 1, InstanceID: "test", Capabilities: map[string]bool{"gatewayConnection": enabled}})
				return
			}
			if r.URL.Path != "/api/integration/v2/runtime/gateway" {
				t.Errorf("错误路径：%s", r.URL.Path)
			}
			writes++
			answer(w, r, map[string]any{"saved": true})
		})
		got := c.Call(context.Background(), "POST", "v2/runtime/gateway", nil, []byte(`{"requestId":"gateway-write","confirmed":true}`))
		if enabled && (!got.OK || got.Protocol != 1 || writes != 1) {
			t.Fatalf("v2桥接失败：%+v 次数=%d", got, writes)
		}
		if !enabled && (got.OK || got.Error.Code != "CAPABILITY_UNSUPPORTED" || writes != 0) {
			t.Fatalf("缺失能力仍写入：%+v 次数=%d", got, writes)
		}
	}
}
