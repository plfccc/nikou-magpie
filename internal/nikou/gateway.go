package nikou

import (
	"errors"
	"net"
	"net/url"
	"strconv"

	"github.com/yetone/magpie/internal/provider"
)

// GatewayConnection 仅包含推理所需的来源标识，不承载控制台管理令牌。
type GatewayConnection struct {
	Origin        string         `json:"origin"`
	AgentToken    string         `json:"agentToken"`
	SessionHeader string         `json:"sessionHeader"`
	Models        []GatewayModel `json:"models"`
}

// GatewayModel 是目录元数据，不代表该模型已经通过 Nikou 执行验收。
type GatewayModel struct {
	ModelRef         string   `json:"modelRef"`
	Name             string   `json:"name,omitempty"`
	Protocol         string   `json:"protocol"`
	ContextWindow    int      `json:"contextWindow,omitempty"`
	MaxOutputTokens  int      `json:"maxOutputTokens,omitempty"`
	Reasoning        bool     `json:"reasoning"`
	SupportedEfforts []string `json:"supportedEfforts"`
	Verified         bool     `json:"verified"`
}

func NewGatewayConnection(origin, agentToken string, entries []provider.Entry) (GatewayConnection, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return GatewayConnection{}, errors.New("网关必须使用本机 HTTP 根地址")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() == "localhost" {
		ip = net.ParseIP("127.0.0.1")
		u.Host = net.JoinHostPort(ip.String(), u.Port())
	}
	port, portErr := strconv.ParseUint(u.Port(), 10, 16)
	if ip == nil || (ip.String() != "127.0.0.1" && ip.String() != "::1") || portErr != nil || port == 0 {
		return GatewayConnection{}, errors.New("网关必须使用明确的回环 IP 和端口")
	}
	if agentToken != "magpie-nikou" {
		return GatewayConnection{}, errors.New("网关来源标识缺失")
	}
	canonicalOrigin := "http://" + net.JoinHostPort(ip.String(), strconv.FormatUint(port, 10))
	if port == 80 {
		canonicalOrigin = "http://" + ip.String()
		if ip.To4() == nil {
			canonicalOrigin = "http://[" + ip.String() + "]"
		}
	}
	out := GatewayConnection{Origin: canonicalOrigin, AgentToken: agentToken, SessionHeader: "X-Magpie-Session", Models: []GatewayModel{}}
	for _, entry := range entries {
		out.Models = append(out.Models, GatewayModel{ModelRef: entry.ID, Name: entry.Name, Protocol: "openai-responses", ContextWindow: max(0, entry.Context), MaxOutputTokens: max(0, entry.Output), Reasoning: entry.Reasoning, SupportedEfforts: append([]string{}, entry.Efforts...)})
	}
	return out, nil
}
