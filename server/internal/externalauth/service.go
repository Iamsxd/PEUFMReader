package externalauth

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-ldap/ldap/v3"
	"golang.org/x/oauth2"
)

type Config struct {
	OIDCIssuerURL         string
	OIDCClientID          string
	OIDCClientSecret      string
	OIDCRedirectURL       string
	OIDCUsernameClaim     string
	OIDCGroupsClaim       string
	OIDCAdminGroup        string
	LDAPURL               string
	LDAPStartTLS          bool
	LDAPBaseDN            string
	LDAPBindDN            string
	LDAPBindPassword      string
	LDAPUserFilter        string
	LDAPUsernameAttribute string
	LDAPAdminGroupDN      string
}

type Identity struct {
	Source   string
	Subject  string
	Username string
	Role     string
}

type Providers struct {
	OIDC bool `json:"oidc"`
	LDAP bool `json:"ldap"`
}

type Service struct {
	oidcVerifier          *oidc.IDTokenVerifier
	oauthConfig           oauth2.Config
	oidcUsernameClaim     string
	oidcGroupsClaim       string
	oidcAdminGroup        string
	ldapURL               string
	ldapStartTLS          bool
	ldapBaseDN            string
	ldapBindDN            string
	ldapBindPassword      string
	ldapUserFilter        string
	ldapUsernameAttribute string
	ldapAdminGroupDN      string
}

func New(ctx context.Context, cfg Config) (*Service, error) {
	service := &Service{
		oidcUsernameClaim:     cfg.OIDCUsernameClaim,
		oidcGroupsClaim:       cfg.OIDCGroupsClaim,
		oidcAdminGroup:        cfg.OIDCAdminGroup,
		ldapURL:               cfg.LDAPURL,
		ldapStartTLS:          cfg.LDAPStartTLS,
		ldapBaseDN:            cfg.LDAPBaseDN,
		ldapBindDN:            cfg.LDAPBindDN,
		ldapBindPassword:      cfg.LDAPBindPassword,
		ldapUserFilter:        cfg.LDAPUserFilter,
		ldapUsernameAttribute: cfg.LDAPUsernameAttribute,
		ldapAdminGroupDN:      cfg.LDAPAdminGroupDN,
	}
	if cfg.OIDCIssuerURL != "" {
		discoveryContext, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		provider, err := oidc.NewProvider(discoveryContext, cfg.OIDCIssuerURL)
		if err != nil {
			return nil, fmt.Errorf("discover OIDC provider: %w", err)
		}
		service.oidcVerifier = provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID})
		service.oauthConfig = oauth2.Config{
			ClientID: cfg.OIDCClientID, ClientSecret: cfg.OIDCClientSecret,
			Endpoint: provider.Endpoint(), RedirectURL: cfg.OIDCRedirectURL,
			Scopes: []string{oidc.ScopeOpenID, "profile", "email"},
		}
	}
	return service, nil
}

func (s *Service) Providers() Providers {
	return Providers{OIDC: s != nil && s.oidcVerifier != nil, LDAP: s != nil && s.ldapURL != ""}
}

func (s *Service) OIDCAuthURL(state, nonce, verifier string) (string, error) {
	if s == nil || s.oidcVerifier == nil {
		return "", errors.New("OIDC is not enabled")
	}
	return s.oauthConfig.AuthCodeURL(
		state,
		oidc.Nonce(nonce),
		oauth2.AccessTypeOffline,
		oauth2.S256ChallengeOption(verifier),
	), nil
}

func (s *Service) VerifyOIDC(ctx context.Context, code, nonce, verifier string) (Identity, error) {
	if s == nil || s.oidcVerifier == nil {
		return Identity{}, errors.New("OIDC is not enabled")
	}
	token, err := s.oauthConfig.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return Identity{}, fmt.Errorf("exchange OIDC code: %w", err)
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		return Identity{}, errors.New("OIDC response did not include an ID token")
	}
	idToken, err := s.oidcVerifier.Verify(ctx, rawIDToken)
	if err != nil {
		return Identity{}, fmt.Errorf("verify OIDC ID token: %w", err)
	}
	if nonce == "" || idToken.Nonce != nonce {
		return Identity{}, errors.New("OIDC nonce mismatch")
	}
	claims := map[string]any{}
	if err := idToken.Claims(&claims); err != nil {
		return Identity{}, fmt.Errorf("decode OIDC claims: %w", err)
	}
	username := claimString(claims[s.oidcUsernameClaim])
	if username == "" {
		return Identity{}, fmt.Errorf("OIDC claim %q is missing", s.oidcUsernameClaim)
	}
	role := "reader"
	if s.oidcAdminGroup != "" && containsFold(claimStrings(claims[s.oidcGroupsClaim]), s.oidcAdminGroup) {
		role = "admin"
	}
	return Identity{Source: "oidc", Subject: idToken.Subject, Username: normalizeUsername(username), Role: role}, nil
}

func (s *Service) AuthenticateLDAP(ctx context.Context, username, password string) (Identity, bool, error) {
	if s == nil || s.ldapURL == "" || strings.TrimSpace(password) == "" {
		return Identity{}, false, nil
	}
	parsedLDAPURL, _ := url.Parse(s.ldapURL)
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: parsedLDAPURL.Hostname()}
	conn, err := ldap.DialURL(s.ldapURL, ldap.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}), ldap.DialWithTLSConfig(tlsConfig))
	if err != nil {
		return Identity{}, false, fmt.Errorf("connect LDAP: %w", err)
	}
	defer conn.Close()
	conn.SetTimeout(10 * time.Second)
	if s.ldapStartTLS {
		if err := conn.StartTLS(tlsConfig); err != nil {
			return Identity{}, false, fmt.Errorf("start LDAP TLS: %w", err)
		}
	}
	if s.ldapBindDN != "" {
		if err := conn.Bind(s.ldapBindDN, s.ldapBindPassword); err != nil {
			return Identity{}, false, fmt.Errorf("LDAP service bind: %w", err)
		}
	}
	filter := strings.ReplaceAll(s.ldapUserFilter, "{username}", ldap.EscapeFilter(strings.TrimSpace(username)))
	result, err := conn.Search(ldap.NewSearchRequest(
		s.ldapBaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 2, 10, false, filter,
		[]string{s.ldapUsernameAttribute, "memberOf"}, nil,
	))
	if err != nil {
		return Identity{}, false, fmt.Errorf("search LDAP user: %w", err)
	}
	if len(result.Entries) != 1 {
		return Identity{}, false, nil
	}
	entry := result.Entries[0]
	if err := conn.Bind(entry.DN, password); err != nil {
		if ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
			return Identity{}, false, nil
		}
		return Identity{}, false, fmt.Errorf("LDAP user bind: %w", err)
	}
	resolvedUsername := entry.GetAttributeValue(s.ldapUsernameAttribute)
	if resolvedUsername == "" {
		resolvedUsername = username
	}
	role := "reader"
	if s.ldapAdminGroupDN != "" && containsFold(entry.GetAttributeValues("memberOf"), s.ldapAdminGroupDN) {
		role = "admin"
	}
	return Identity{Source: "ldap", Subject: entry.DN, Username: normalizeUsername(resolvedUsername), Role: role}, true, nil
}

func claimString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func claimStrings(value any) []string {
	switch typed := value.(type) {
	case string:
		return []string{typed}
	case []string:
		return typed
	case []any:
		values := make([]string, 0, len(typed))
		for _, item := range typed {
			if value := claimString(item); value != "" {
				values = append(values, value)
			}
		}
		return values
	default:
		return nil
	}
}

func containsFold(values []string, expected string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(expected)) {
			return true
		}
	}
	return false
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
