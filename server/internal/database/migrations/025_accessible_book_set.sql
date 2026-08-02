CREATE OR REPLACE FUNCTION accessible_book_ids(p_user_id BIGINT)
RETURNS TABLE(book_file_id BIGINT)
LANGUAGE sql
STABLE
AS $$
    WITH account AS MATERIALIZED (
        SELECT id, role
        FROM users
        WHERE id = p_user_id AND disabled_at IS NULL
    ), user_library_permissions AS MATERIALIZED (
        SELECT permission.library_group_id,
               bool_or(permission.can_read = false) AS has_deny,
               bool_or(permission.can_read = true) AS has_allow
        FROM user_group_members membership
        JOIN user_group_library_permissions permission
          ON permission.user_group_id = membership.user_group_id
        WHERE membership.user_id = p_user_id
        GROUP BY permission.library_group_id
    ), grouped_access AS MATERIALIZED (
        SELECT membership.book_file_id,
               bool_or(COALESCE(permission.has_deny, false)) AS has_deny,
               bool_or(COALESCE(permission.has_allow, false)) AS has_allow,
               bool_or(library_group.default_access = false) AS has_private_membership
        FROM library_group_books membership
        JOIN library_groups library_group ON library_group.id = membership.library_group_id
        LEFT JOIN user_library_permissions permission ON permission.library_group_id = membership.library_group_id
        GROUP BY membership.book_file_id
    )
    SELECT book.id
    FROM account
    CROSS JOIN book_files book
    LEFT JOIN book_file_permissions direct_permission
      ON direct_permission.user_id = account.id
     AND direct_permission.book_file_id = book.id
    LEFT JOIN grouped_access access ON access.book_file_id = book.id
    WHERE CASE
        WHEN account.role = 'admin' THEN true
        WHEN direct_permission.can_read IS NOT NULL THEN direct_permission.can_read
        WHEN COALESCE(access.has_deny, false) THEN false
        WHEN COALESCE(access.has_allow, false) THEN true
        WHEN COALESCE(access.has_private_membership, false) THEN false
        ELSE true
    END;
$$;
