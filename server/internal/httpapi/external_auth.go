package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"peufmreader/internal/externalauth"
	"peufmreader/internal/store"
)

const (
	oidcStateCookie    = "peufm_oidc_state"
	oidcNonceCookie    = "peufm_oidc_nonce"
	oidcVerifierCookie = "peufm_oidc_verifier"
)

func (a *API) ConfigureExternalAuth(service *externalauth.Service) {
	a.externalAuth = service
}

func (a *API) authProviders(w http.ResponseWriter, _ *http.Request) {
	providers := externalauth.Providers{}
	if a.externalAuth != nil {
		providers = a.externalAuth.Providers()
	}
	writeJSON(w, http.StatusOK, providers)
}

func (a *API) startOIDC(w http.ResponseWriter, r *http.Request) {
	if a.externalAuth == nil || !a.externalAuth.Providers().OIDC {
		writeError(w, http.StatusNotFound, "oidc_disabled", "OIDC login is not enabled")
		return
	}
	state, err := randomToken(32)
	if err != nil {
		a.internalError(w, err)
		return
	}
	nonce, err := randomToken(32)
	if err != nil {
		a.internalError(w, err)
		return
	}
	verifier, err := randomToken(48)
	if err != nil {
		a.internalError(w, err)
		return
	}
	a.setOIDCCookie(w, oidcStateCookie, state, 600)
	a.setOIDCCookie(w, oidcNonceCookie, nonce, 600)
	a.setOIDCCookie(w, oidcVerifierCookie, verifier, 600)
	authURL, err := a.externalAuth.OIDCAuthURL(state, nonce, verifier)
	if err != nil {
		a.internalError(w, err)
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (a *API) oidcCallback(w http.ResponseWriter, r *http.Request) {
	state, stateOK := readCookie(r, oidcStateCookie)
	nonce, nonceOK := readCookie(r, oidcNonceCookie)
	verifier, verifierOK := readCookie(r, oidcVerifierCookie)
	a.clearOIDCCookies(w)
	if !stateOK || !nonceOK || !verifierOK || state == "" || r.URL.Query().Get("state") != state {
		writeError(w, http.StatusBadRequest, "oidc_state_invalid", "OIDC login state is invalid or expired")
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		writeError(w, http.StatusUnauthorized, "oidc_login_failed", "identity provider rejected the login")
		return
	}
	identity, err := a.externalAuth.VerifyOIDC(r.Context(), r.URL.Query().Get("code"), nonce, verifier)
	if err != nil {
		a.logger.Warn("OIDC callback failed", "error", err)
		writeError(w, http.StatusUnauthorized, "oidc_login_failed", "OIDC login could not be verified")
		return
	}
	user, err := a.store.UpsertExternalUser(r.Context(), identity.Source, identity.Subject, identity.Username, identity.Role)
	if err != nil {
		a.externalUserError(w, err)
		return
	}
	if _, err := a.establishSession(w, r, user); err != nil {
		a.internalError(w, err)
		return
	}
	http.Redirect(w, r, "/#/home", http.StatusFound)
}

func (a *API) externalUserError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrExternalIdentityConflict):
		writeError(w, http.StatusConflict, "external_identity_conflict", "external username conflicts with an existing account; ask an administrator to resolve it")
	case errors.Is(err, store.ErrExternalUserDisabled):
		writeError(w, http.StatusForbidden, "account_disabled", "this account is disabled")
	default:
		a.internalError(w, err)
	}
}

func (a *API) setOIDCCookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/api/v1/auth/oidc/callback", HttpOnly: true,
		Secure: a.cookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: maxAge,
		Expires: time.Now().Add(time.Duration(maxAge) * time.Second),
	})
}

func (a *API) clearOIDCCookies(w http.ResponseWriter) {
	for _, name := range []string{oidcStateCookie, oidcNonceCookie, oidcVerifierCookie} {
		http.SetCookie(w, &http.Cookie{
			Name: name, Path: "/api/v1/auth/oidc/callback", HttpOnly: true,
			Secure: a.cookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0),
		})
	}
}

func readCookie(r *http.Request, name string) (string, bool) {
	cookie, err := r.Cookie(name)
	return func() string {
		if err != nil {
			return ""
		}
		return cookie.Value
	}(), err == nil
}
