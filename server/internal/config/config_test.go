package config

import "testing"

func TestEnvOrIfUnsetPreservesExplicitEmptyValue(t *testing.T) {
	t.Setenv("PEUFM_TEST_OPTION", "")
	if value := envOrIfUnset("PEUFM_TEST_OPTION", "default"); value != "" {
		t.Fatalf("envOrIfUnset()=%q, want explicit empty value", value)
	}
}
