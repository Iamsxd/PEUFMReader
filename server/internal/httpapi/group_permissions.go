package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"peufmreader/internal/store"
)

type accessGroupInput struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	DefaultAccess *bool  `json:"defaultAccess,omitempty"`
}

func (a *API) listUserGroups(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListUserGroups(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) createUserGroup(w http.ResponseWriter, r *http.Request) {
	var input accessGroupInput
	if err := readJSON(w, r, &input, 8<<10); err != nil {
		return
	}
	if !validAccessGroupInput(input.Name, input.Description) {
		writeError(w, http.StatusBadRequest, "invalid_user_group", "name must be 1-80 characters and description at most 500 characters")
		return
	}
	item, err := a.store.CreateUserGroup(r.Context(), input.Name, input.Description)
	if !a.writeAccessGroupResult(w, err) {
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *API) updateUserGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input accessGroupInput
	if err := readJSON(w, r, &input, 8<<10); err != nil {
		return
	}
	if !validAccessGroupInput(input.Name, input.Description) {
		writeError(w, http.StatusBadRequest, "invalid_user_group", "name must be 1-80 characters and description at most 500 characters")
		return
	}
	item, found, err := a.store.UpdateUserGroup(r.Context(), id, input.Name, input.Description)
	if !a.writeAccessGroupResult(w, err) {
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "user_group_not_found", "user group not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) deleteUserGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	deleted, err := a.store.DeleteUserGroup(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "user_group_not_found", "user group not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) addUserGroupMember(w http.ResponseWriter, r *http.Request) {
	a.setUserGroupMember(w, r, true)
}

func (a *API) removeUserGroupMember(w http.ResponseWriter, r *http.Request) {
	a.setUserGroupMember(w, r, false)
}

func (a *API) setUserGroupMember(w http.ResponseWriter, r *http.Request, member bool) {
	groupID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	userID, ok := parseID(w, r.PathValue("userId"))
	if !ok || !a.ensureUserGroupExists(w, r, groupID) || !a.ensureManagedUserExists(w, r, userID) {
		return
	}
	if err := a.store.SetUserGroupMember(r.Context(), groupID, userID, member); err != nil {
		a.internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) listLibraryGroups(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListLibraryGroups(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) createLibraryGroup(w http.ResponseWriter, r *http.Request) {
	var input accessGroupInput
	if err := readJSON(w, r, &input, 8<<10); err != nil {
		return
	}
	if !validAccessGroupInput(input.Name, input.Description) || input.DefaultAccess == nil {
		writeError(w, http.StatusBadRequest, "invalid_library_group", "name, description and defaultAccess are required")
		return
	}
	item, err := a.store.CreateLibraryGroup(r.Context(), input.Name, input.Description, *input.DefaultAccess)
	if !a.writeAccessGroupResult(w, err) {
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *API) updateLibraryGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input accessGroupInput
	if err := readJSON(w, r, &input, 8<<10); err != nil {
		return
	}
	if !validAccessGroupInput(input.Name, input.Description) || input.DefaultAccess == nil {
		writeError(w, http.StatusBadRequest, "invalid_library_group", "name, description and defaultAccess are required")
		return
	}
	item, found, err := a.store.UpdateLibraryGroup(r.Context(), id, input.Name, input.Description, *input.DefaultAccess)
	if !a.writeAccessGroupResult(w, err) {
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "library_group_not_found", "library group not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) deleteLibraryGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	deleted, err := a.store.DeleteLibraryGroup(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "library_group_not_found", "library group not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) addLibraryGroupBook(w http.ResponseWriter, r *http.Request) {
	a.setLibraryGroupBook(w, r, true)
}

func (a *API) removeLibraryGroupBook(w http.ResponseWriter, r *http.Request) {
	a.setLibraryGroupBook(w, r, false)
}

func (a *API) setLibraryGroupBook(w http.ResponseWriter, r *http.Request, member bool) {
	groupID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	bookID, ok := parseID(w, r.PathValue("bookId"))
	if !ok || !a.ensureLibraryGroupExists(w, r, groupID) {
		return
	}
	if _, found, err := a.store.GetBookFile(r.Context(), bookID); err != nil {
		a.internalError(w, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	if err := a.store.SetLibraryGroupBook(r.Context(), groupID, bookID, member); err != nil {
		a.internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) listGroupLibraryPermissions(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListGroupLibraryPermissions(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) setGroupLibraryPermission(w http.ResponseWriter, r *http.Request) {
	userGroupID, libraryGroupID, ok := a.parseGroupPermissionIDs(w, r)
	if !ok {
		return
	}
	var input struct {
		CanRead *bool `json:"canRead"`
	}
	if err := readJSON(w, r, &input, 4<<10); err != nil {
		return
	}
	if input.CanRead == nil {
		writeError(w, http.StatusBadRequest, "invalid_group_permission", "canRead is required")
		return
	}
	item, err := a.store.SetGroupLibraryPermission(r.Context(), userGroupID, libraryGroupID, *input.CanRead)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) deleteGroupLibraryPermission(w http.ResponseWriter, r *http.Request) {
	userGroupID, libraryGroupID, ok := a.parseGroupPermissionIDs(w, r)
	if !ok {
		return
	}
	deleted, err := a.store.DeleteGroupLibraryPermission(r.Context(), userGroupID, libraryGroupID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "group_permission_not_found", "group library permission not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) parseGroupPermissionIDs(w http.ResponseWriter, r *http.Request) (int64, int64, bool) {
	userGroupID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return 0, 0, false
	}
	libraryGroupID, ok := parseID(w, r.PathValue("libraryGroupId"))
	if !ok || !a.ensureUserGroupExists(w, r, userGroupID) || !a.ensureLibraryGroupExists(w, r, libraryGroupID) {
		return 0, 0, false
	}
	return userGroupID, libraryGroupID, true
}

func (a *API) ensureUserGroupExists(w http.ResponseWriter, r *http.Request, id int64) bool {
	_, found, err := a.store.GetUserGroup(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return false
	}
	if !found {
		writeError(w, http.StatusNotFound, "user_group_not_found", "user group not found")
	}
	return found
}

func (a *API) ensureLibraryGroupExists(w http.ResponseWriter, r *http.Request, id int64) bool {
	_, found, err := a.store.GetLibraryGroup(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return false
	}
	if !found {
		writeError(w, http.StatusNotFound, "library_group_not_found", "library group not found")
	}
	return found
}

func (a *API) ensureManagedUserExists(w http.ResponseWriter, r *http.Request, id int64) bool {
	_, found, err := a.store.GetManagedUser(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return false
	}
	if !found {
		writeError(w, http.StatusNotFound, "user_not_found", "user not found")
	}
	return found
}

func (a *API) writeAccessGroupResult(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	if errors.Is(err, store.ErrAccessGroupNameConflict) {
		writeError(w, http.StatusConflict, "group_name_conflict", "a group with this name already exists")
		return false
	}
	a.internalError(w, err)
	return false
}

func validAccessGroupInput(name, description string) bool {
	name = strings.TrimSpace(name)
	return utf8.RuneCountInString(name) >= 1 && utf8.RuneCountInString(name) <= 80 && utf8.RuneCountInString(description) <= 500
}
