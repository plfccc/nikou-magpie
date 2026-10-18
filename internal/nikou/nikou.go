package nikou

import (
	"context"
	"encoding/json"
	"net/url"
)

// State 仅承载界面所需的运行摘要，不包含认证文件。
type State struct {
	Status map[string]any `json:"status"`
	Scopes map[string]any `json:"scopes"`
}

func (c *ConsoleClient) Hello(ctx context.Context) Reply {
	return c.Call(ctx, "GET", "hello", nil, nil)
}

func (c *ConsoleClient) Status(ctx context.Context) Reply {
	return c.Call(ctx, "GET", "status", nil, nil)
}

func (c *ConsoleClient) Catalog(ctx context.Context, engine, model string, refresh bool) Reply {
	q := url.Values{"engine": []string{engine}, "model": []string{model}}
	if refresh {
		q.Set("refresh", "1")
	}
	return c.Call(ctx, "GET", "runtime/catalog", q, nil)
}

func (c *ConsoleClient) Operation(ctx context.Context, id string) Reply {
	return c.Call(ctx, "GET", "operations/"+id, nil, nil)
}

func (c *ConsoleClient) Write(ctx context.Context, route, id string, value any) Reply {
	b, err := json.Marshal(value)
	if err != nil {
		return Failure(id, "INVALID_REQUEST", "请求参数无法编码", false)
	}
	return c.Call(ctx, "POST", route, nil, b)
}
