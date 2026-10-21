package nikou

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const maxReplyBytes = 2 << 20

var safeID = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,100}$`)

type ConsoleClient struct {
	base      string
	tokenPath string
	http      *http.Client
}

func NewConsoleClient(base, tokenPath string) (*ConsoleClient, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("控制台地址必须是本机 HTTP 根地址")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, errors.New("控制台仅允许本机回环地址")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &ConsoleClient{base: strings.TrimSuffix(base, "/"), tokenPath: tokenPath, http: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func allowedRoute(method, route string) bool {
	if strings.HasPrefix(route, "v2/") {
		switch method + " " + strings.TrimPrefix(route, "v2/") {
		case "GET runtime/profiles", "GET runtime/catalog", "GET runtime/status", "POST runtime/profiles/validate", "POST runtime/profiles/update", "POST runtime/gateway":
			return true
		}
		return false
	}
	if method == "GET" {
		switch route {
		case "hello", "status", "runtime/catalog", "accounts", "company-tools", "jobs", "jobs/detail", "jobs/log", "jobs/service":
			return true
		}
		return strings.HasPrefix(route, "operations/") && safeID.MatchString(strings.TrimPrefix(route, "operations/"))
	}
	if method == "POST" {
		switch route {
		case "runtime/select", "worker/control", "accounts/select", "accounts/refresh", "company-tools/action", "jobs/action", "jobs/service":
			return true
		}
	}
	return false
}

func (c *ConsoleClient) Call(ctx context.Context, method, route string, query url.Values, body []byte) Reply {
	id := requestID()
	if !allowedRoute(method, route) {
		return Failure(id, "INVALID_REQUEST", "接口不受支持", false)
	}
	if method == "POST" {
		var in struct {
			RequestID string `json:"requestId"`
		}
		if len(body) > 1<<20 || json.Unmarshal(body, &in) != nil || !safeID.MatchString(in.RequestID) {
			return Failure(id, "INVALID_REQUEST", "写操作必须携带有效的请求 ID", false)
		}
		id = in.RequestID
	}
	if route != "hello" {
		hello := c.exchange(ctx, "GET", "hello", nil, nil, id)
		if !hello.OK {
			return hello
		}
		if strings.HasPrefix(route, "v2/") {
			raw, _ := json.Marshal(hello.Data)
			var data Hello
			capability := "runtimeProfilesV2"
			if route == "v2/runtime/gateway" {
				capability = "gatewayConnection"
			}
			valid := json.Unmarshal(raw, &data) == nil
			supported := data.Capabilities[capability] || route == "v2/runtime/catalog" && data.Capabilities["gatewayConnection"]
			if !valid || !supported {
				return Failure(id, "CAPABILITY_UNSUPPORTED", "Nikou 控制台尚不支持运行档案，请更新公司组件组合", false)
			}
		}
	}
	return c.exchange(ctx, method, route, query, body, id)
}

func (c *ConsoleClient) exchange(ctx context.Context, method, route string, query url.Values, body []byte, id string) Reply {
	token, err := os.ReadFile(c.tokenPath)
	if err != nil || len(bytes.TrimSpace(token)) == 0 || len(token) > 4096 {
		return Failure(id, "CONSOLE_NOT_READY", "Nikou 控制台尚未初始化，或本机令牌不可读", false)
	}
	limit := 5 * time.Second
	if method == "POST" {
		limit = 15 * time.Second
	}
	if route == "accounts/refresh" {
		limit = 60 * time.Second
	}
	if route == "company-tools" {
		limit = 45 * time.Second
	}
	if route == "jobs" || route == "jobs/detail" || route == "jobs/log" || route == "jobs/service" {
		limit = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	endpoint := c.base + "/api/integration/v1/" + route
	if strings.HasPrefix(route, "v2/") {
		endpoint = c.base + "/api/integration/" + route
	}
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return Failure(id, "INVALID_REQUEST", "请求参数无效", false)
	}
	req.Header.Set("X-Nikou-Console-Token", strings.TrimSpace(string(token)))
	req.Header.Set("X-Nikou-Request-Id", id)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		if method == "POST" {
			return Failure(id, "OPERATION_UNKNOWN", "操作结果尚未确认，请刷新状态或查询操作回执", false)
		}
		return Failure(id, "CONSOLE_UNAVAILABLE", "无法连接本机 Nikou 控制台", true)
	}
	defer res.Body.Close()
	if res.StatusCode == 401 || res.StatusCode == 403 {
		return Failure(id, "CONSOLE_AUTH_FAILED", "本机控制台认证失败", false)
	}
	invalid := func(code, message string) Reply {
		if method == "POST" {
			return Failure(id, "OPERATION_UNKNOWN", "操作结果尚未确认，请刷新状态或查询操作回执", false)
		}
		return Failure(id, code, message, false)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxReplyBytes+1))
	if err != nil || len(raw) > maxReplyBytes {
		return invalid("INVALID_RESPONSE", "控制台响应无法读取或超过大小限制")
	}
	var reply Reply
	if json.Unmarshal(raw, &reply) != nil || reply.Protocol != Protocol || reply.RequestID != id || (reply.OK && (reply.Data == nil || reply.Error != nil)) || (!reply.OK && (reply.Error == nil || reply.Error.Code == "")) {
		return invalid("PROTOCOL_INCOMPATIBLE", "控制台响应与当前协议不匹配")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if reply.OK {
			return invalid("CONSOLE_REJECTED", "控制台未返回已确认的操作结果")
		}
		return reply
	}
	if route == "hello" && reply.OK {
		var data Hello
		raw, err := json.Marshal(reply.Data)
		if err != nil || json.Unmarshal(raw, &data) != nil || data.Service != "nikou-console" || data.Protocol != Protocol || data.InstanceID == "" {
			return Failure(id, "PROTOCOL_INCOMPATIBLE", "Nikou 控制台版本不兼容，请更新公司组件组合", false)
		}
	}
	return reply
}
