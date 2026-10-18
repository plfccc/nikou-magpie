package nikou

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testConsole(t *testing.T, handle http.HandlerFunc) *ConsoleClient {
	t.Helper()
	s := httptest.NewServer(handle)
	t.Cleanup(s.Close)
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("test-console-token"), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := NewConsoleClient(s.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConsolePreservesTrustedHTTPFailures(t *testing.T) {
	for _, status := range []int{400, 409, 422} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			writes := 0
			c := testConsole(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					answer(w, r, Hello{Service: "nikou-console", Protocol: Protocol, InstanceID: "instance"})
					return
				}
				writes++
				w.WriteHeader(status)
				json.NewEncoder(w).Encode(Failure(r.Header.Get("X-Nikou-Request-Id"), "REQUEST_ID_CONFLICT", "请求已被拒绝", false))
			})
			got := c.Call(context.Background(), "POST", "accounts/select", nil, []byte(`{"requestId":"write-trusted"}`))
			if got.OK || got.Error.Code != "REQUEST_ID_CONFLICT" || got.RequestID != "write-trusted" || writes != 1 {
				t.Fatalf("丢失确定拒绝结果：%+v 次数=%d", got, writes)
			}
		})
	}
}

func TestConsoleDirectHelloValidatesIdentity(t *testing.T) {
	for _, hello := range []Hello{{Service: "other", Protocol: Protocol, InstanceID: "test"}, {Service: "nikou-console", Protocol: 2, InstanceID: "test"}, {Service: "nikou-console", Protocol: Protocol}} {
		c := testConsole(t, func(w http.ResponseWriter, r *http.Request) { answer(w, r, hello) })
		if got := c.Call(context.Background(), "GET", "hello", nil, nil); got.OK || got.Error.Code != "PROTOCOL_INCOMPATIBLE" {
			t.Fatalf("接受不兼容握手：%+v", got)
		}
	}
}

func TestConsoleMalformedWriteReplyIsUnknown(t *testing.T) {
	for _, body := range []string{`{`, `{"protocol":1,"requestId":"wrong","ok":false,"error":{"code":"INVALID_REQUEST"}}`, `{"protocol":1,"requestId":"malformed-write","ok":true}`} {
		c := testConsole(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "GET" {
				answer(w, r, Hello{Service: "nikou-console", Protocol: Protocol, InstanceID: "test"})
				return
			}
			w.Write([]byte(body))
		})
		got := c.Call(context.Background(), "POST", "accounts/select", nil, []byte(`{"requestId":"malformed-write"}`))
		if got.OK || got.Error.Code != "OPERATION_UNKNOWN" {
			t.Fatalf("结果应无法确认：%+v", got)
		}
	}
}

func TestConsoleCanceledWriteIsUnknownWithoutReplay(t *testing.T) {
	started := make(chan struct{})
	writes := 0
	c := testConsole(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			answer(w, r, Hello{Service: "nikou-console", Protocol: Protocol, InstanceID: "test"})
			return
		}
		io.Copy(io.Discard, r.Body)
		writes++
		close(started)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Reply, 1)
	go func() { done <- c.Call(ctx, "POST", "accounts/select", nil, []byte(`{"requestId":"cancel-write"}`)) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("请求未发出")
	}
	cancel()
	got := <-done
	if got.OK || got.Error.Code != "OPERATION_UNKNOWN" || writes != 1 {
		t.Fatalf("取消结果错误：%+v 次数=%d", got, writes)
	}
}

func TestConsoleHandshakeFailureKeepsWriteRequestID(t *testing.T) {
	c := testConsole(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) })
	got := c.Call(context.Background(), "POST", "accounts/select", nil, []byte(`{"requestId":"handshake-failed"}`))
	if got.RequestID != "handshake-failed" || got.Error.Code != "CONSOLE_AUTH_FAILED" {
		t.Fatalf("握手失败丢失请求 ID：%+v", got)
	}
}

func answer(rw http.ResponseWriter, r *http.Request, data any) {
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(Reply{Protocol: 1, RequestID: r.Header.Get("X-Nikou-Request-Id"), OK: true, Data: data})
}

func TestConsoleHandshakeAndToken(t *testing.T) {
	c := testConsole(t, func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Nikou-Console-Token") != "test-console-token" {
			t.Error("没有传递本机令牌")
		}
		if r.URL.Path != "/api/integration/v1/hello" {
			t.Error(r.URL.Path)
		}
		answer(rw, r, Hello{Service: "nikou-console", Protocol: 1, PackageVersion: "0.1.89", InstanceID: "test", Capabilities: map[string]bool{"workerControl": true}})
	})
	reply := c.Call(context.Background(), "GET", "hello", nil, nil)
	if !reply.OK {
		t.Fatalf("握手失败：%+v", reply.Error)
	}
}

func TestConsoleRejectsRemoteAndRedirect(t *testing.T) {
	for _, base := range []string{"http://example.com:19736", "http://127.0.0.1:19736/path", "http://user:secret@localhost:19736", "https://localhost:19736", "http://127.0.0.1:19736?x=1"} {
		if _, err := NewConsoleClient(base, "token"); err == nil {
			t.Errorf("未拒绝目标：%s", base)
		}
	}
	c := testConsole(t, func(rw http.ResponseWriter, r *http.Request) {
		http.Redirect(rw, r, "http://example.com/", http.StatusFound)
	})
	if got := c.Call(context.Background(), "GET", "hello", nil, nil); got.OK {
		t.Fatal("不应跟随重定向")
	}
}

func TestConsoleProtocolMismatchBlocksWrites(t *testing.T) {
	writes := 0
	c := testConsole(t, func(rw http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			writes++
		}
		answer(rw, r, Hello{Service: "nikou-console", Protocol: 2, InstanceID: "other"})
	})
	got := c.Call(context.Background(), "POST", "worker/control", nil, []byte(`{"requestId":"test-write","action":"stop","confirmed":true}`))
	if got.OK || got.Error.Code != "PROTOCOL_INCOMPATIBLE" || writes != 0 {
		t.Fatalf("没有阻止写入：%+v，次数=%d", got, writes)
	}
}

func TestConsoleWritesAreNotRetried(t *testing.T) {
	writes := 0
	c := testConsole(t, func(rw http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			answer(rw, r, Hello{Service: "nikou-console", Protocol: 1, InstanceID: "test"})
			return
		}
		writes++
		rw.WriteHeader(503)
	})
	got := c.Call(context.Background(), "POST", "worker/control", nil, []byte(`{"requestId":"write-1","action":"stop","confirmed":true}`))
	if got.OK || writes != 1 {
		t.Fatalf("写入被重放或误报成功：%+v，次数=%d", got, writes)
	}
}

func TestConsoleRejectsInvalidRequestWithoutNetwork(t *testing.T) {
	c := testConsole(t, func(rw http.ResponseWriter, r *http.Request) { t.Error("无效请求不应到达控制台") })
	for _, route := range []string{"../status", "https://example.com", "prompts", "operations/../../status"} {
		if got := c.Call(context.Background(), "POST", route, nil, []byte(`{}`)); got.OK {
			t.Error(route)
		}
	}
	if got := c.Call(context.Background(), "POST", "worker/control", nil, []byte(`{"requestId":"bad id"}`)); got.OK {
		t.Fatal("接受了无效操作 ID")
	}
}

func TestConsoleRedactsAuthenticationAndLimitsReplies(t *testing.T) {
	c := testConsole(t, func(rw http.ResponseWriter, r *http.Request) {
		rw.WriteHeader(401)
		rw.Write([]byte(`{"message":"test-console-token secret-upstream"}`))
	})
	got := c.Call(context.Background(), "GET", "hello", nil, nil)
	b, _ := json.Marshal(got)
	if got.OK || strings.Contains(string(b), "test-console-token") || strings.Contains(string(b), "secret-upstream") {
		t.Fatal(string(b))
	}
	c = testConsole(t, func(rw http.ResponseWriter, r *http.Request) { rw.Write([]byte(strings.Repeat("x", maxReplyBytes+1))) })
	if got := c.Call(context.Background(), "GET", "hello", nil, nil); got.OK {
		t.Fatal("接受了过大响应")
	}
}
