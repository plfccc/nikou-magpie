package nikou

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

type AccountRef struct {
	Engine     string `json:"engine"`
	ProviderID string `json:"providerId"`
	AccountID  string `json:"accountId"`
}

type AccountRequest struct {
	Protocol   int         `json:"protocol"`
	RequestID  string      `json:"requestId"`
	Op         string      `json:"op"`
	Engine     string      `json:"engine"`
	AccountRef *AccountRef `json:"accountRef,omitempty"`
}

type AccountProfile struct {
	ID         string     `json:"id"`
	Alias      string     `json:"alias"`
	Current    bool       `json:"current"`
	Account    string     `json:"account"`
	PlanLabel  string     `json:"planLabel"`
	UsageLabel string     `json:"usageLabel"`
	RuleLabel  string     `json:"ruleLabel"`
	UpdatedAt  string     `json:"updatedAt"`
	FetchOK    bool       `json:"fetchOk"`
	Stale      bool       `json:"stale"`
	Ref        AccountRef `json:"ref"`
}

type AccountList struct {
	CurrentAlias string           `json:"currentAlias"`
	Profiles     []AccountProfile `json:"profiles"`
}

type AccountService struct {
	List    func(string) []provider.Login
	ID      func(string, string) string
	Quotas  func(time.Time) []provider.Quota
	Switch  func(string, string) error
	Refresh func(context.Context, string, string, time.Time) []provider.Quota
}

func DefaultAccountService() *AccountService {
	return &AccountService{List: provider.Logins, ID: provider.LoginID, Quotas: provider.KeptQuotaReport, Switch: provider.SwitchLogin, Refresh: provider.RefreshReport}
}

func EncodeAccountRef(ref AccountRef) string {
	b, _ := json.Marshal(ref)
	return base64.RawURLEncoding.EncodeToString(b)
}

func DecodeAccountRef(id string) (AccountRef, error) {
	var ref AccountRef
	if len(id) > 8192 {
		return ref, errors.New("账号引用过长")
	}
	b, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil || json.Unmarshal(b, &ref) != nil || ref.Engine == "" || ref.ProviderID == "" || ref.AccountID == "" || EncodeAccountRef(ref) != id {
		return AccountRef{}, errors.New("账号引用无效")
	}
	return ref, nil
}

func (s *AccountService) Handle(ctx context.Context, request AccountRequest) Reply {
	id := request.RequestID
	if request.Protocol != Protocol || !safeID.MatchString(id) {
		return Failure(id, "INVALID_REQUEST", "桥接协议或请求 ID 无效", false)
	}
	if request.Engine != "codex" && request.Engine != "claude" {
		return Failure(id, "CAPABILITY_UNSUPPORTED", "当前版本仅支持 Codex 与 Claude 的原生账号", false)
	}
	if request.Op != "accounts.list" && request.Op != "accounts.select" && request.Op != "accounts.refresh" {
		return Failure(id, "INVALID_REQUEST", "账号操作不受支持", false)
	}
	list := s.list(request.Engine)
	if request.Op == "accounts.list" {
		return Success(id, list)
	}
	ref := request.AccountRef
	if ref == nil || ref.Engine != request.Engine || ref.ProviderID != request.Engine {
		return Failure(id, "INVALID_ACCOUNT_REF", "账号引用与引擎不匹配", false)
	}
	var target *AccountProfile
	for i := range list.Profiles {
		if list.Profiles[i].Ref == *ref {
			target = &list.Profiles[i]
			break
		}
	}
	if target == nil {
		return Failure(id, "ACCOUNT_NOT_FOUND", "账号已变化，请重新查询列表", false)
	}
	if request.Op == "accounts.select" {
		if err := s.Switch(request.Engine, target.Account); err != nil {
			return Failure(id, "ACCOUNT_SELECT_FAILED", "原生账号切换失败，请重新核对登录状态", false)
		}
		return Success(id, map[string]any{"ok": true, "engine": request.Engine, "alias": target.Alias, "providerId": ref.ProviderID, "requiresRestart": true})
	}
	rows := s.Refresh(ctx, request.Engine, target.Account, time.Now())
	for _, q := range rows {
		if q.Provider != ref.ProviderID || !strings.EqualFold(q.User, target.Account) {
			continue
		}
		if q.Error != "" || q.ReadDeferred || q.AsOf != nil {
			return Failure(id, "QUOTA_REFRESH_FAILED", "额度刷新未获得有效结果，保留上次快照", false)
		}
		updated := time.Now().UTC().Format(time.RFC3339)
		if q.ReadAt != nil {
			updated = q.ReadAt.UTC().Format(time.RFC3339)
		}
		return Success(id, map[string]any{"ref": ref, "updatedAt": updated})
	}
	return Failure(id, "QUOTA_REFRESH_FAILED", "未找到对应账号的额度结果", false)
}

func (s *AccountService) list(engine string) AccountList {
	result := AccountList{Profiles: []AccountProfile{}}
	quotas := s.Quotas(time.Now())
	for _, login := range s.List(engine) {
		ref := AccountRef{Engine: engine, ProviderID: engine, AccountID: s.ID(engine, login.User)}
		p := AccountProfile{ID: EncodeAccountRef(ref), Alias: login.User, Account: login.User, PlanLabel: login.Plan, Current: login.Active, Stale: true, Ref: ref}
		for _, q := range quotas {
			if q.Provider != engine || !strings.EqualFold(q.User, login.User) {
				continue
			}
			if q.Alias != "" {
				p.Alias = q.Alias
			}
			if q.Plan != "" {
				p.PlanLabel = q.Plan
			}
			p.FetchOK = q.Error == "" && !q.ReadDeferred
			p.Stale = !p.FetchOK || q.AsOf != nil
			if q.ReadAt != nil {
				p.UpdatedAt = q.ReadAt.UTC().Format(time.RFC3339)
			}
			var parts []string
			for _, window := range q.Windows {
				parts = append(parts, fmt.Sprintf("%s 剩余 %.0f%%", window.Name, window.Remaining))
			}
			p.UsageLabel = strings.Join(parts, "；")
			if q.Error != "" {
				p.UsageLabel = "额度查询失败，保留上次快照"
			}
			break
		}
		if p.Current {
			result.CurrentAlias = p.Alias
		}
		result.Profiles = append(result.Profiles, p)
	}
	return result
}
