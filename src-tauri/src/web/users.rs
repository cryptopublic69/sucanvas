// Web user accounts. The table lives in the canvas database so it travels with
// existing backups; only the server creates or migrates it (desktop keeps app-lock).
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::Serialize;
use std::{path::Path, sync::Mutex};
use uuid::Uuid;

pub const ADMIN_USERNAME: &str = "admin";
const DISPLAY_NAME_MAX: usize = 64;
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    password_changed_at TEXT
)";
const COLUMNS: &str = "id, username, display_name, role, disabled, must_change_password, created_at, updated_at, password_changed_at, password_hash";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::User => "user",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRecord {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub role: Role,
    pub disabled: bool,
    pub must_change_password: bool,
    pub created_at: String,
    pub updated_at: String,
    pub password_changed_at: Option<String>,
}

pub struct Credential {
    pub user: UserRecord,
    pub password_hash: String,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn credential(row: &Row<'_>) -> rusqlite::Result<Credential> {
    let role: String = row.get(3)?;
    Ok(Credential {
        user: UserRecord {
            id: row.get(0)?,
            username: row.get(1)?,
            display_name: row.get(2)?,
            role: if role == "admin" {
                Role::Admin
            } else {
                Role::User
            },
            disabled: row.get::<_, i64>(4)? != 0,
            must_change_password: row.get::<_, i64>(5)? != 0,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            password_changed_at: row.get(8)?,
        },
        password_hash: row.get(9)?,
    })
}

fn open(database: &Path) -> Result<Connection, String> {
    let connection = Connection::open(database).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

// ASCII only: SQLite NOCASE folds ASCII, so login and uniqueness agree.
pub fn validate_username(username: &str) -> Result<(), String> {
    let length = username.chars().count();
    if !(3..=32).contains(&length)
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err("用户名需为 3–32 位英文字母、数字或 _ - .".to_owned());
    }
    Ok(())
}

fn normalize_display_name(display_name: Option<String>) -> Result<Option<String>, String> {
    let display_name = display_name
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());
    if display_name
        .as_ref()
        .is_some_and(|name| name.chars().count() > DISPLAY_NAME_MAX)
    {
        return Err(format!("显示名不能超过 {DISPLAY_NAME_MAX} 个字符"));
    }
    Ok(display_name)
}

fn insert(
    connection: &Connection,
    username: &str,
    display_name: Option<&str>,
    password_hash: &str,
    role: Role,
    must_change_password: bool,
) -> rusqlite::Result<String> {
    let id = Uuid::new_v4().to_string();
    let time = now();
    connection.execute(
        "INSERT INTO users (id, username, display_name, password_hash, role, disabled, must_change_password, created_at, updated_at, password_changed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?7, ?7)",
        params![id, username, display_name, password_hash, role.as_str(), must_change_password as i64, time],
    )?;
    Ok(id)
}

// Runs once per server start. Creates the table and, when no account exists,
// an admin that keeps app-lock.json's hash byte for byte. One transaction:
// a failure leaves neither the table nor a partial account behind.
pub fn migrate(database: &Path, app_lock: &Path) -> Result<(), String> {
    let mut connection = open(database)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    transaction
        .execute_batch(SCHEMA)
        .map_err(|e| e.to_string())?;
    let count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if count == 0 {
        let hash = super::auth::read_hash(app_lock)?;
        insert(
            &transaction,
            ADMIN_USERNAME,
            None,
            &hash,
            Role::Admin,
            false,
        )
        .map_err(|e| e.to_string())?;
    }
    // Canvas ownership belongs to the same step: either both migrations land or neither.
    let admin_id: String = transaction
        .query_row(
            "SELECT id FROM users WHERE role = 'admin' ORDER BY username = 'admin' DESC, created_at LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    super::ownership::migrate(&transaction, &admin_id)?;
    transaction.commit().map_err(|e| e.to_string())
}

// Local recovery (`--reset-admin-password`): the "admin" account gets a new
// password and is an enabled admin again, without a forced change on next
// sign-in, so signing in as admin always works afterwards.
pub fn reset_admin_password(database: &Path, password_hash: &str) -> Result<(), String> {
    let connection = open(database)?;
    let time = now();
    let changed = connection
        .execute(
            "UPDATE users SET password_hash = ?1, role = 'admin', disabled = 0, must_change_password = 0, password_changed_at = ?2, updated_at = ?2
             WHERE username = ?3",
            params![password_hash, time, ADMIN_USERNAME],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("找不到用户名为 admin 的账号".to_owned());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum AdminChange {
    Role(Role),
    Disabled(bool),
}

pub struct Users {
    connection: Mutex<Connection>,
}

impl Users {
    pub fn open(database: &Path) -> Result<Self, String> {
        Ok(Self {
            connection: Mutex::new(open(database)?),
        })
    }

    fn find(&self, condition: &str, value: &str) -> Result<Option<Credential>, String> {
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM users WHERE {condition} = ?1"),
                [value],
                credential,
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn by_username(&self, username: &str) -> Result<Option<Credential>, String> {
        self.find("username", username)
    }

    pub fn by_id(&self, id: &str) -> Result<Option<Credential>, String> {
        self.find("id", id)
    }

    pub fn list(&self) -> Result<Vec<UserRecord>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {COLUMNS} FROM users ORDER BY created_at, username"
            ))
            .map_err(|e| e.to_string())?;
        let mut users = Vec::new();
        for row in statement
            .query_map([], credential)
            .map_err(|e| e.to_string())?
        {
            users.push(row.map_err(|e| e.to_string())?.user);
        }
        Ok(users)
    }

    pub fn create(
        &self,
        username: &str,
        display_name: Option<String>,
        role: Role,
        password_hash: &str,
    ) -> Result<UserRecord, String> {
        validate_username(username)?;
        let display_name = normalize_display_name(display_name)?;
        let id = {
            let connection = self.connection.lock().unwrap();
            insert(
                &connection,
                username,
                display_name.as_deref(),
                password_hash,
                role,
                true,
            )
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(failure, _)
                    if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    "用户名已存在".to_owned()
                }
                error => error.to_string(),
            })?
        };
        self.user(&id)
    }

    fn user(&self, id: &str) -> Result<UserRecord, String> {
        self.by_id(id)?
            .map(|credential| credential.user)
            .ok_or_else(|| "用户不存在".to_owned())
    }

    // `expected_hash` makes the write conditional, so a concurrent reset is not overwritten.
    pub fn set_password(
        &self,
        id: &str,
        password_hash: &str,
        must_change_password: bool,
        expected_hash: Option<&str>,
    ) -> Result<UserRecord, String> {
        let changed = {
            let connection = self.connection.lock().unwrap();
            let time = now();
            connection
                .execute(
                    "UPDATE users SET password_hash = ?2, must_change_password = ?3, password_changed_at = ?4, updated_at = ?4
                     WHERE id = ?1 AND (?5 IS NULL OR password_hash = ?5)",
                    params![id, password_hash, must_change_password as i64, time, expected_hash],
                )
                .map_err(|e| e.to_string())?
        };
        if changed == 0 {
            return Err("密码已被修改，请重试".to_owned());
        }
        self.user(id)
    }

    // Role and disabled changes share the last-admin rule: at least one enabled
    // admin must remain. The other column is read inside the write transaction
    // and only the changed column is written, so concurrent changes compose.
    fn update_admin_state(&self, id: &str, change: AdminChange) -> Result<UserRecord, String> {
        {
            let mut connection = self.connection.lock().unwrap();
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let current = transaction
                .query_row(
                    "SELECT role, disabled FROM users WHERE id = ?1",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)? == "admin",
                            row.get::<_, i64>(1)? != 0,
                        ))
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((is_admin, is_disabled)) = current else {
                return Err("用户不存在".to_owned());
            };
            let (role, disabled) = match change {
                AdminChange::Role(role) => (role, is_disabled),
                AdminChange::Disabled(disabled) => {
                    (if is_admin { Role::Admin } else { Role::User }, disabled)
                }
            };
            let other_admins: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if other_admins == 0 && (role != Role::Admin || disabled) {
                return Err("至少需要保留一个启用的管理员".to_owned());
            }
            match change {
                AdminChange::Role(role) => transaction.execute(
                    "UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, role.as_str(), now()],
                ),
                AdminChange::Disabled(disabled) => transaction.execute(
                    "UPDATE users SET disabled = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, disabled as i64, now()],
                ),
            }
            .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
        }
        self.user(id)
    }

    pub fn set_disabled(&self, id: &str, disabled: bool) -> Result<UserRecord, String> {
        self.update_admin_state(id, AdminChange::Disabled(disabled))
    }

    pub fn set_role(&self, id: &str, role: Role) -> Result<UserRecord, String> {
        self.update_admin_state(id, AdminChange::Role(role))
    }

    pub fn set_display_name(
        &self,
        id: &str,
        display_name: Option<String>,
    ) -> Result<UserRecord, String> {
        let display_name = normalize_display_name(display_name)?;
        let changed = {
            let connection = self.connection.lock().unwrap();
            connection
                .execute(
                    "UPDATE users SET display_name = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, display_name, now()],
                )
                .map_err(|e| e.to_string())?
        };
        if changed == 0 {
            return Err("用户不存在".to_owned());
        }
        self.user(id)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    pub(crate) struct Fixture {
        pub root: PathBuf,
    }

    impl Fixture {
        pub(crate) fn new() -> Self {
            let root = std::env::temp_dir().join(format!("web-users-{}", Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }
        pub(crate) fn database(&self) -> PathBuf {
            self.root.join("infinite-canvas.sqlite3")
        }
        pub(crate) fn app_lock(&self) -> PathBuf {
            self.root.join("app-lock.json")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn table_exists(database: &Path) -> bool {
        Connection::open(database)
            .unwrap()
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'",
                [],
                |_| Ok(()),
            )
            .optional()
            .unwrap()
            .is_some()
    }

    #[test]
    fn first_migration_creates_admin_with_the_app_lock_hash_and_keeps_the_file() {
        let fixture = Fixture::new();
        super::super::auth::write_password(&fixture.app_lock(), "原有应用锁密码").unwrap();
        let lock_before = std::fs::read(fixture.app_lock()).unwrap();
        let hash = super::super::auth::read_hash(&fixture.app_lock()).unwrap();
        migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        let users = Users::open(&fixture.database()).unwrap();
        let admin = users.by_username("admin").unwrap().unwrap();
        assert_eq!(admin.password_hash.as_bytes(), hash.as_bytes());
        assert_eq!(admin.user.role, Role::Admin);
        assert!(!admin.user.must_change_password && !admin.user.disabled);
        assert_eq!(std::fs::read(fixture.app_lock()).unwrap(), lock_before);
        // A second start with a different app-lock changes nothing.
        super::super::auth::write_password(&fixture.app_lock(), "另一个密码").unwrap();
        migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        assert_eq!(users.list().unwrap().len(), 1);
        assert_eq!(
            users.by_username("ADMIN").unwrap().unwrap().password_hash,
            hash
        );
    }

    #[test]
    fn migration_without_app_lock_refuses_and_writes_nothing() {
        let fixture = Fixture::new();
        assert!(migrate(&fixture.database(), &fixture.app_lock()).is_err());
        assert!(!table_exists(&fixture.database()));
        std::fs::write(fixture.app_lock(), b"broken").unwrap();
        assert!(migrate(&fixture.database(), &fixture.app_lock()).is_err());
        assert!(!table_exists(&fixture.database()));
        assert_eq!(std::fs::read(fixture.app_lock()).unwrap(), b"broken");
    }

    #[test]
    fn usernames_are_case_insensitive_unique_and_validated() {
        let fixture = Fixture::new();
        super::super::auth::write_password(&fixture.app_lock(), "原有应用锁密码").unwrap();
        migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        let users = Users::open(&fixture.database()).unwrap();
        users
            .create("Alice", Some(" 爱丽丝 ".into()), Role::User, "hash")
            .unwrap();
        assert_eq!(
            users.create("alice", None, Role::User, "hash").unwrap_err(),
            "用户名已存在"
        );
        let alice = users.by_username("ALICE").unwrap().unwrap().user;
        assert_eq!(alice.display_name.as_deref(), Some("爱丽丝"));
        assert!(alice.must_change_password);
        for bad in ["ab", "has space", "名字abc", &"a".repeat(33)] {
            assert!(
                users.create(bad, None, Role::User, "hash").is_err(),
                "{bad}"
            );
        }
    }

    // 012a review: a role change and a disable running concurrently must not
    // undo each other, so each writes only its own column (read inside the
    // transaction). A trigger records which columns an UPDATE names.
    #[test]
    fn role_and_disabled_changes_write_only_their_own_column() {
        let fixture = Fixture::new();
        super::super::auth::write_password(&fixture.app_lock(), "原有应用锁密码").unwrap();
        migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        let users = Users::open(&fixture.database()).unwrap();
        let erin = users.create("erin", None, Role::User, "hash").unwrap();
        let log = Connection::open(fixture.database()).unwrap();
        log.execute_batch(
            "CREATE TABLE touched (col TEXT);
             CREATE TRIGGER role_touched AFTER UPDATE OF role ON users BEGIN INSERT INTO touched VALUES ('role'); END;
             CREATE TRIGGER disabled_touched AFTER UPDATE OF disabled ON users BEGIN INSERT INTO touched VALUES ('disabled'); END;",
        )
        .unwrap();
        let touched = || -> Vec<String> {
            let mut statement = log.prepare("SELECT col FROM touched").unwrap();
            let rows = statement.query_map([], |row| row.get(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        users.set_disabled(&erin.id, true).unwrap();
        assert_eq!(touched(), vec!["disabled"]);
        // A second handle (another request) changes the role in between: the
        // earlier disable stays, and the role change keeps disabled as it is.
        let other = Users::open(&fixture.database()).unwrap();
        other.set_role(&erin.id, Role::Admin).unwrap();
        assert_eq!(touched(), vec!["disabled", "role"]);
        let erin = users.by_id(&erin.id).unwrap().unwrap().user;
        assert!(erin.disabled && erin.role == Role::Admin);
    }

    #[test]
    fn reset_admin_password_restores_access_to_the_admin_account() {
        let fixture = Fixture::new();
        super::super::auth::write_password(&fixture.app_lock(), "原有应用锁密码").unwrap();
        migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        let users = Users::open(&fixture.database()).unwrap();
        let admin = users.by_username("admin").unwrap().unwrap().user;
        users.create("second", None, Role::Admin, "hash").unwrap();
        users.set_disabled(&admin.id, true).unwrap();
        users.set_role(&admin.id, Role::User).unwrap();
        users
            .set_password(&admin.id, "temporary", true, None)
            .unwrap();
        reset_admin_password(&fixture.database(), "new-hash").unwrap();
        let admin = users.by_username("admin").unwrap().unwrap();
        assert_eq!(admin.password_hash, "new-hash");
        assert!(!admin.user.disabled && !admin.user.must_change_password);
        assert_eq!(admin.user.role, Role::Admin);
        let lock_before = std::fs::read(fixture.app_lock()).unwrap();
        Connection::open(fixture.database())
            .unwrap()
            .execute(
                "UPDATE users SET username = 'renamed' WHERE username = 'admin'",
                [],
            )
            .unwrap();
        assert!(reset_admin_password(&fixture.database(), "x").is_err());
        assert_eq!(std::fs::read(fixture.app_lock()).unwrap(), lock_before);
    }

    #[test]
    fn last_enabled_admin_cannot_be_disabled_or_demoted() {
        let fixture = Fixture::new();
        super::super::auth::write_password(&fixture.app_lock(), "原有应用锁密码").unwrap();
        migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        let users = Users::open(&fixture.database()).unwrap();
        let admin = users.by_username("admin").unwrap().unwrap().user;
        assert!(users.set_disabled(&admin.id, true).is_err());
        assert!(users.set_role(&admin.id, Role::User).is_err());
        let second = users.create("second", None, Role::Admin, "hash").unwrap();
        users.set_disabled(&second.id, true).unwrap();
        // A disabled admin does not count as the remaining admin.
        assert!(users.set_role(&admin.id, Role::User).is_err());
        users.set_disabled(&second.id, false).unwrap();
        users.set_role(&admin.id, Role::User).unwrap();
        assert!(users.set_disabled(&second.id, true).is_err());
    }
}
