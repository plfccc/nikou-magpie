// Package nikou 注册 Nikou 控制台管理页面。
package nikou

import "github.com/yetone/magpie/internal/pluginrt"

// Settings 定义本地控制台连接与页面轮询参数。
type Settings struct {
	Port        int `json:"port" title:"控制台端口" description:"本机 Nikou 控制台的监听端口" min:"1024" max:"65535"`
	PollSeconds int `json:"pollSeconds" title:"状态刷新间隔（秒）" description:"仅在 Nikou 页面可见时自动刷新状态" min:"5" max:"120"`
}

func init() {
	pluginrt.Register(pluginrt.Manifest{
		ID: "nikou", API: "^1", Requires: []string{"window"},
		Name: "Nikou 管理", Sub: "查看运行状态、设置会话模型并管理本地工作进程",
		Parts:    []pluginrt.Part{{Slot: "nav.page", Key: "nikou"}},
		Settings: Settings{Port: 19736, PollSeconds: 10},
		Client:   []string{"nikou.css", "client.js"},
	})
}
