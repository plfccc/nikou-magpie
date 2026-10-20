package gui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/company"
	"github.com/yetone/magpie/internal/proc"
)

type upstreamItem struct {
	Name       string `json:"name"`
	Baseline   string `json:"baseline"`
	Repository string `json:"repository"`
	Ref        string `json:"ref"`
	Latest     string `json:"latest,omitempty"`
	State      string `json:"state"`
	Error      string `json:"error,omitempty"`
}
type upstreamStatus struct {
	Maintenance  map[string]interface{} `json:"maintenance,omitempty"`
	NikouVersion string                 `json:"nikouVersion,omitempty"`
	Checking     bool                   `json:"checking"`
	CheckedAt    string                 `json:"checkedAt,omitempty"`
	Items        []upstreamItem         `json:"items"`
}
type upstreamChecker struct {
	mu     sync.Mutex
	status upstreamStatus
}

var companyUpstreams = &upstreamChecker{}

func (c *upstreamChecker) snapshot() upstreamStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.status
	var lock struct {
		Nikou struct {
			Version string `json:"version"`
		} `json:"nikou"`
	}
	if json.Unmarshal(company.UpstreamsLock, &lock) == nil {
		s.NikouVersion = lock.Nikou.Version
	}
	s.Items = append([]upstreamItem(nil), s.Items...)
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		if data, err := os.ReadFile(filepath.Join(base, "NikouMagpie", "maintenance", "latest.json")); err == nil && len(data) < 65536 {
			var latest map[string]interface{}
			if json.Unmarshal(data, &latest) == nil {
				s.Maintenance = make(map[string]interface{})
				for _, key := range []string{"status", "summary", "message", "completedAt", "startedAt", "notification"} {
					s.Maintenance[key] = latest[key]
				}
			}
		}
	}
	return s
}

func (c *upstreamChecker) check() {
	c.mu.Lock()
	if c.status.Checking {
		c.mu.Unlock()
		return
	}
	c.status.Checking = true
	c.mu.Unlock()
	s := queryCompanyUpstreams(context.Background(), &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, company.UpstreamsLock, company.UpstreamsPolicy)
	c.mu.Lock()
	c.status = s
	c.mu.Unlock()
}

func queryCompanyUpstreams(ctx context.Context, client *http.Client, lockBytes, policyBytes []byte) upstreamStatus {
	return queryCompanyUpstreamsWithGit(ctx, client, lockBytes, policyBytes, gitUpstreamCommit)
}

func queryCompanyUpstreamsWithGit(ctx context.Context, client *http.Client, lockBytes, policyBytes []byte, gitRead func(context.Context, string, string) (string, error)) upstreamStatus {
	s := upstreamStatus{CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	type component struct {
		Repository string            `json:"repository"`
		Commit     string            `json:"commit"`
		Channels   map[string]string `json:"channels"`
	}
	var locked, sources struct {
		Magpie component `json:"magpie"`
		Nikou  component `json:"nikou"`
	}
	lockErr := json.Unmarshal(lockBytes, &locked)
	policyErr := json.Unmarshal(policyBytes, &sources)
	lock := map[string]component{"magpie": locked.Magpie, "nikou": locked.Nikou}
	policy := map[string]component{"magpie": sources.Magpie, "nikou": sources.Nikou}
	for _, name := range []string{"magpie", "nikou"} {
		item := upstreamItem{Name: name, Baseline: lock[name].Commit, Repository: lock[name].Repository, Ref: policy[name].Channels["stable"], State: "unknown"}
		endpoint, err := upstreamEndpoint(policy[name].Repository, policy[name].Channels["stable"])
		if lockErr != nil || policyErr != nil || item.Baseline == "" || policy[name].Repository != lock[name].Repository || err != nil {
			item.Error = "构建中的上游基线配置不可用"
		} else {
			var latest string
			if name == "nikou" {
				latest, err = gitRead(ctx, policy[name].Repository, policy[name].Channels["stable"])
			} else {
				latest, err = upstreamCommit(ctx, client, endpoint)
				if errors.Is(err, errUpstreamRateLimit) {
					latest, err = gitRead(ctx, policy[name].Repository, policy[name].Channels["stable"])
				}
			}
			if err != nil {
				item.Error = err.Error()
			} else {
				item.Latest = latest
				item.State = "changed"
				if strings.EqualFold(item.Baseline, latest) {
					item.State = "current"
				}
			}
		}
		s.Items = append(s.Items, item)
	}
	return s
}

func gitUpstreamCommit(ctx context.Context, repository, ref string) (string, error) {
	source := "GitHub"
	if strings.Contains(repository, "gitlab.inzwc.com/") {
		source = "GitLab"
	}
	if _, err := upstreamEndpoint(repository, ref); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := proc.CommandContext(ctx, "git", "-c", "credential.interactive=false", "ls-remote", "--exit-code", "--refs", "--", repository, ref)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never")
	// 沿用 Git 凭证助手，不读取凭证或回传可能含敏感信息的 stderr。
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("%s 查询超时，请检查网络或公司 VPN", source)
		}
		if _, missing := err.(*exec.Error); missing {
			return "", fmt.Errorf("未找到 Git，请安装 Git 后重试上游检查")
		}
		return "", fmt.Errorf("%s 查询失败，请检查网络及本机 Git 配置", source)
	}
	fields := strings.Fields(string(out))
	if len(fields) != 2 || fields[1] != ref || !validUpstreamCommit(fields[0]) {
		return "", fmt.Errorf("%s 未返回有效分支提交", source)
	}
	return fields[0], nil
}

func validUpstreamCommit(commit string) bool {
	if len(commit) != 40 {
		return false
	}
	for _, ch := range commit {
		if !strings.ContainsRune("0123456789abcdefABCDEF", ch) {
			return false
		}
	}
	return true
}

func upstreamEndpoint(repository, ref string) (string, error) {
	u, err := url.Parse(repository)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || ref == "" {
		return "", fmt.Errorf("上游配置无效")
	}
	branch := strings.TrimPrefix(ref, "refs/heads/")
	project := strings.TrimSuffix(strings.Trim(u.Path, "/"), ".git")
	switch {
	case u.Scheme == "https" && u.Host == "github.com" && project == "yetone/magpie":
		return "https://api.github.com/repos/" + project + "/commits/" + url.PathEscape(branch), nil
	case (u.Scheme == "http" || u.Scheme == "https") && u.Host == "gitlab.inzwc.com" && project == "nikou/nikou-cli":
		return u.Scheme + "://" + u.Host + "/api/v4/projects/" + url.PathEscape(project) + "/repository/commits/" + url.PathEscape(branch), nil
	}
	return "", fmt.Errorf("上游地址不在允许范围")
}

var errUpstreamRateLimit = errors.New("GitHub 匿名查询额度已用尽，请稍后重试")

func upstreamCommit(ctx context.Context, client *http.Client, endpoint string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("无法创建上游检查请求")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Nikou-Magpie-Upstream-Check")
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("无法连接上游，请检查网络或公司 VPN")
	}
	defer res.Body.Close()
	if (res.StatusCode == http.StatusForbidden && res.Header.Get("X-RateLimit-Remaining") == "0") || res.StatusCode == http.StatusTooManyRequests {
		return "", errUpstreamRateLimit
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("上游查询返回 HTTP %d，请稍后重试或检查网络", res.StatusCode)
	}
	var body struct {
		SHA string `json:"sha"`
		ID  string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("上游响应无法解析")
	}
	commit := body.SHA
	if commit == "" {
		commit = body.ID
	}
	if len(commit) != 40 {
		return "", fmt.Errorf("上游未返回有效提交")
	}
	for _, ch := range commit {
		if !strings.ContainsRune("0123456789abcdefABCDEF", ch) {
			return "", fmt.Errorf("上游未返回有效提交")
		}
	}
	return commit, nil
}
