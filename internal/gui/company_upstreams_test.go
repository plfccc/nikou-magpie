package gui

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/company"
	"github.com/yetone/magpie/internal/update"
)

type upstreamTransport func(*http.Request) (*http.Response, error)

func TestCompanyUpstreamsGitHubRateLimitFallsBackToGit(t *testing.T) {
	for _, code := range []int{403, 429} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			client := &http.Client{Transport: upstreamTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: code, Header: http.Header{"X-Ratelimit-Remaining": {"0"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
			})}
			calls := 0
			s := queryCompanyUpstreamsWithGit(context.Background(), client, company.UpstreamsLock, company.UpstreamsPolicy, func(_ context.Context, repo, ref string) (string, error) {
				calls++
				if ref != "refs/heads/main" {
					t.Fatal(ref)
				}
				return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", nil
			})
			if calls != 2 || s.Items[0].State != "changed" || s.Items[0].Error != "" {
				t.Fatalf("限流应回退只读 Git: %+v", s)
			}
		})
	}
}

func TestCompanyUpstreamsGitLabFailureIsUnknown(t *testing.T) {
	client := &http.Client{Transport: upstreamTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"sha":"d783df46cbac9021e26a6bd71ca0b55544552eb2"}`)), Header: make(http.Header)}, nil
	})}
	s := queryCompanyUpstreamsWithGit(context.Background(), client, company.UpstreamsLock, company.UpstreamsPolicy, func(context.Context, string, string) (string, error) {
		return "", fmt.Errorf("GitLab 查询失败，请检查网络及本机 Git 仓库认证")
	})
	if s.Items[1].State != "unknown" || s.Items[1].Latest != "" || s.Items[1].Error == "" {
		t.Fatalf("失败不能误报最新: %+v", s)
	}
}

func TestCompanyUpstreamsLiveGitLab(t *testing.T) {
	if os.Getenv("NIKOU_TEST_LIVE_UPSTREAM") != "1" {
		t.Skip("仅在显式运行真实上游验收时联网")
	}
	commit, err := gitUpstreamCommit(context.Background(), "http://gitlab.inzwc.com/nikou/nikou-cli.git", "refs/heads/main")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("GitLab main=%s", commit)
}

func TestCompanyUpstreamsLiveGitHub(t *testing.T) {
	if os.Getenv("NIKOU_TEST_LIVE_UPSTREAM") != "1" {
		t.Skip("仅在显式运行真实上游验收时联网")
	}
	s := queryCompanyUpstreams(context.Background(), &http.Client{Timeout: 12 * time.Second}, company.UpstreamsLock, company.UpstreamsPolicy)
	if s.Items[0].State == "unknown" {
		t.Fatalf("GitHub 查询失败: %+v", s.Items[0])
	}
	t.Logf("GitHub main=%s, state=%s", s.Items[0].Latest, s.Items[0].State)
}

func (f upstreamTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCompanyUpstreamsReportsDifferenceAndUnknown(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
		code             int
	}{
		{"same", `{"sha":"d783df46cbac9021e26a6bd71ca0b55544552eb2"}`, "current", 200},
		{"changed", `{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, "changed", 200},
		{"private", `{"message":"secret response must not be exposed"}`, "unknown", 401},
		{"malformed", `<html>login</html>`, "unknown", 200},
		{"invalid commit", `{"sha":"no"}`, "unknown", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: upstreamTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Header.Get("Authorization") != "" || r.Header.Get("Private-Token") != "" || r.URL.User != nil {
					t.Fatal("检查不得传递仓库凭证")
				}
				return &http.Response{StatusCode: tc.code, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header)}, nil
			})}
			gitCalls := 0
			s := queryCompanyUpstreamsWithGit(context.Background(), client, company.UpstreamsLock, company.UpstreamsPolicy, func(_ context.Context, repo, ref string) (string, error) {
				gitCalls++
				if repo != "http://gitlab.inzwc.com/nikou/nikou-cli.git" || ref != "refs/heads/main" {
					t.Fatal("GitLab 查询目标错误")
				}
				return "c1ebb2c55df0e8102ca028049f033e1a64fb41f1", nil
			})
			if calls != 1 || gitCalls != 1 || s.Items[1].State != "current" || len(s.Items) != 2 || s.Items[0].State != tc.want || s.CheckedAt == "" {
				t.Fatalf("结果不符: %+v", s)
			}
			for _, item := range s.Items {
				if strings.Contains(item.Error, "secret") {
					t.Fatal("泄漏响应正文")
				}
			}
		})
	}
}

func TestCompanyUpstreamsBrokenBaselineDoesNotClaimLatest(t *testing.T) {
	client := &http.Client{Transport: upstreamTransport(func(*http.Request) (*http.Response, error) { t.Fatal("损坏基线不得联网"); return nil, nil })}
	s := queryCompanyUpstreams(context.Background(), client, []byte("broken"), company.UpstreamsPolicy)
	for _, item := range s.Items {
		if item.State != "unknown" || item.Error == "" {
			t.Fatalf("结果不符: %+v", s)
		}
	}
}

func TestCompanyUpstreamsRejectsUnapprovedURLs(t *testing.T) {
	for _, repo := range []string{"https://secret@github.com/yetone/magpie.git", "https://evil.test/nikou/nikou-cli.git", "https://github.com/yetone/magpie.git?token=secret"} {
		if _, err := upstreamEndpoint(repo, "refs/heads/main"); err == nil {
			t.Fatalf("未拒绝 %s", repo)
		}
	}
}

func TestCompanyVersionUsesReadOnlyUpstreams(t *testing.T) {
	old := update.CompanyMode
	update.CompanyMode = "1"
	t.Cleanup(func() { update.CompanyMode = old })
	u := &updater{state: "ready", staged: "must-not-install"}
	s := u.json()
	if s.State != "company" || s.Upstreams == nil || s.Latest != "" {
		t.Fatalf("公司版本不应提供官方升级: %+v", s)
	}
	if s.Upstreams.NikouVersion == "" {
		t.Fatal("首次检查前也应展示已安装的 Nikou 版本")
	}
}
