package update

import (
	"context"
	"strings"
	"testing"
)

func TestCompanyBuildNeverUsesOfficialSingleComponentUpdate(t *testing.T) {
	before := CompanyMode
	CompanyMode = "1"
	t.Cleanup(func() { CompanyMode = before })
	t.Setenv("MAGPIE_UPDATE_FEED", "https://usemagpie.ai/api/latest")
	if Feed() != "" || NotesFeed() != "" || ReleasePage("1.0.0") != "" {
		t.Fatal("公司版本不应返回官方更新入口")
	}
	_, err := LatestIn(context.Background(), "zh")
	if err == nil || !strings.Contains(err.Error(), "公司") {
		t.Fatal("公司独立更新必须被拒绝")
	}
}
