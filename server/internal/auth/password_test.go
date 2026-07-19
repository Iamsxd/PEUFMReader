package auth

import "testing"

func TestHashAndVerifyPassword(t *testing.T) {
	encoded, err := HashPassword("a-strong-test-password")
	if err != nil {
		t.Fatalf("HashPassword returned error: %v", err)
	}
	if !VerifyPassword(encoded, "a-strong-test-password") {
		t.Fatal("correct password did not verify")
	}
	if VerifyPassword(encoded, "wrong-password") {
		t.Fatal("wrong password verified")
	}
}

func TestVerifyPasswordRejectsMalformedHash(t *testing.T) {
	malformed := []string{"", "not-a-hash", "$argon2id$v=19$m=9999999,t=3,p=2$YQ$YQ"}
	for _, encoded := range malformed {
		if VerifyPassword(encoded, "password") {
			t.Fatalf("malformed hash %q verified", encoded)
		}
	}
}
