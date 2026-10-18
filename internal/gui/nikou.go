package gui

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/yetone/magpie/internal/nikou"
	"github.com/yetone/magpie/internal/pluginrt"
)

// NikouAssetsCheck 供无副作用自检使用，仅检查嵌入资源。
func NikouAssetsCheck() error {
	for _, file := range []string{"assets/plugins/nikou/client.js", "assets/plugins/nikou/nikou.css"} {
		if b, err := assets.ReadFile(file); err != nil || len(b) == 0 {
			return errors.New("Nikou 内置页面资源缺失")
		}
	}
	return nil
}

func nikouPort() (int, bool) {
	list, err := pluginrt.Refresh()
	if err != nil {
		return 0, false
	}
	for _, p := range list {
		if p.ID != "nikou" || !p.Enabled {
			continue
		}
		port := 19736
		switch v := p.Config["port"].(type) {
		case int:
			port = v
		case int64:
			port = int(v)
		case float64:
			port = int(v)
		}
		return port, port >= 1024 && port <= 65535
	}
	return 0, false
}

func nikouRoutes(mux *http.ServeMux, w Windows) {
	mux.HandleFunc("/api/nikou/", nikouHandler(w, nikouPort))
}

var nikouRequestID = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,100}$`)

func nikouHandler(w Windows, portLookup func() (int, bool)) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Cache-Control", "no-store")
		id := "nikou-local"
		body, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
		if err != nil || len(body) > 1<<20 {
			writeJSON(rw, nikou.Failure(id, "INVALID_REQUEST", "请求超过大小限制", false))
			return
		}
		var input struct {
			RequestID string `json:"requestId"`
			Confirmed bool   `json:"confirmed"`
		}
		if r.Method == "POST" {
			if json.Unmarshal(body, &input) != nil || !nikouRequestID.MatchString(input.RequestID) {
				writeJSON(rw, nikou.Failure(id, "INVALID_REQUEST", "写操作必须携带有效的请求 ID", false))
				return
			}
			id = input.RequestID
		}
		port, on := portLookup()
		if !on {
			writeJSON(rw, nikou.Failure(id, "PLUGIN_DISABLED", "Nikou 插件未启用或配置不可读", false))
			return
		}
		if isWeb(w) {
			writeJSON(rw, nikou.Failure(id, "LOCAL_DESKTOP_ONLY", "Nikou 管理入口仅在本机桌面使用", false))
			return
		}
		base := fmt.Sprintf("http://127.0.0.1:%d", port)
		route := strings.TrimPrefix(r.URL.Path, "/api/nikou/")
		if route == "open" && r.Method == "POST" {
			if !input.Confirmed || w == nil {
				writeJSON(rw, nikou.Failure(id, "INVALID_REQUEST", "打开控制台需要确认及本机桌面入口", false))
				return
			}
			if err := w.OpenURL(base + "/"); err != nil {
				writeJSON(rw, nikou.Failure(id, "OPEN_FAILED", "无法打开浏览器，请手动访问本机控制台", false))
				return
			}
			writeJSON(rw, nikou.Success(id, map[string]any{"url": base + "/", "opened": true}))
			return
		}
		home, err := os.UserHomeDir()
		if err != nil {
			writeJSON(rw, nikou.Failure(id, "CONSOLE_NOT_READY", "无法定位本机 Nikou 配置", false))
			return
		}
		client, err := nikou.NewConsoleClient(base, filepath.Join(home, ".nikou-block", "console", "token"))
		if err != nil {
			writeJSON(rw, nikou.Failure(id, "CONSOLE_NOT_READY", "控制台配置无效", false))
			return
		}
		writeJSON(rw, client.Call(r.Context(), r.Method, route, r.URL.Query(), body))
	}
}
