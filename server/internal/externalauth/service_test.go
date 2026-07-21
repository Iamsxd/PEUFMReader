package externalauth

import "testing"

func TestClaimStringsAndAdminGroupMatching(t *testing.T) {
	groups := claimStrings([]any{"readers", "library-admins", 42})
	if len(groups) != 2 || !containsFold(groups, "LIBRARY-ADMINS") {
		t.Fatalf("unexpected normalized groups: %#v", groups)
	}
}

func TestNormalizeUsername(t *testing.T) {
	if got := normalizeUsername("  Alice.Example "); got != "alice.example" {
		t.Fatalf("normalizeUsername()=%q", got)
	}
}
