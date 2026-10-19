// Web RPC allowlist, maintained by hand. Every command is a `Command` variant. `permissions` and `dispatch` both
// match exhaustively, so a new command does not compile until it declares
// which permission category it needs.
use super::{
    auth::{Permission, Session},
    authz::{NodeScope, RecordRefs},
    canvases,
    ownership::{CanvasOwner, Ownership},
    presence,
    rpc::{argument, channel},
    users::{Actor, Role},
    WebState,
};
use crate::{
    commands,
    models::{
        CancelFolderUndoRecord, CreateEdgeInput, CreateNodeInput, DeleteNodesInput, DeletedBatch,
        EdgeRecord, FolderActionInput, FolderGroupingUndoRecord, FolderMergeSourceSnapshot,
        FolderMergeUndoRecord, FolderTreeUndoRecord, GroupNodesIntoFolderInput,
        GroupRelatedNodesIntoFolderInput, MergeFoldersInput, NodeRecord, PromptSceneBindingRecord,
        ReplaceNodeAndDeleteInput, RestoreNodeReplacementInput, SetProjectPreviewImageInput,
        UndoCancelFolderInput, UndoDeleteFolderInput, UndoFolderGroupingInput,
        UndoFolderMergeInput, UpdateNodeInput, UpdateProjectInput,
    },
    platform::{Channel, State},
    video_upscale,
};
use serde_json::Value;
use std::sync::RwLock;

macro_rules! commands {
    ($($variant:ident => $name:literal,)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Command {
            $($variant,)*
        }
        impl Command {
            pub const ALL: &'static [Command] = &[$(Command::$variant,)*];
            pub fn name(self) -> &'static str {
                match self {
                    $(Command::$variant => $name,)*
                }
            }
        }
    };
}

commands! {
    ExportAppBackup => "export_app_backup",
    StageAppBackupRestore => "stage_app_backup_restore",
    TakeRestoredFrontendSettings => "take_restored_frontend_settings",
    GetAppLockStatus => "get_app_lock_status",
    VerifyAppLockPassword => "verify_app_lock_password",
    SetAppLockPassword => "set_app_lock_password",
    DisableAppLock => "disable_app_lock",
    LoadWorkspace => "load_workspace",
    UpdateCanvasSelection => "update_canvas_selection",
    InspectWorkspace => "inspect_workspace",
    ListProjects => "list_projects",
    ListProjectSummaries => "list_project_summaries",
    CreateProject => "create_project",
    GroupNodesIntoFolder => "group_nodes_into_folder",
    CreateEmptyFolder => "create_empty_folder",
    GroupRelatedNodesIntoFolder => "group_related_nodes_into_folder",
    UndoFolderGrouping => "undo_folder_grouping",
    MergeFolders => "merge_folders",
    UndoFolderMerge => "undo_folder_merge",
    CancelFolder => "cancel_folder",
    UndoCancelFolder => "undo_cancel_folder",
    DeleteFolderTree => "delete_folder_tree",
    UndoDeleteFolderTree => "undo_delete_folder_tree",
    UpdateProject => "update_project",
    SetProjectPrivate => "set_project_private",
    // Web only (CANVAS-012c2).
    AdminDeleteProject => "admin_delete_project",
    UpdateCanvasSettings => "update_canvas_settings",
    CopyProject => "copy_project",
    // Web only (CANVAS-012c3).
    PresenceHeartbeat => "presence_heartbeat",
    PresenceLeave => "presence_leave",
    // Web only (CANVAS-012c4): orphan media cleanup.
    ListMediaCleanup => "list_media_cleanup",
    TrashMediaFiles => "trash_media_files",
    RestoreMediaFiles => "restore_media_files",
    PurgeMediaFiles => "purge_media_files",
    SetProjectPreviewImage => "set_project_preview_image",
    DeleteProject => "delete_project",
    CreateNode => "create_node",
    ImportMedia => "import_media",
    ExportMediaAsset => "export_media_asset",
    ExportGeneratedVideo => "export_generated_video",
    ExportGeneratedImage => "export_generated_image",
    CleanupResizeImages => "cleanup_resize_images",
    ResizeImage => "resize_image",
    UpdateNode => "update_node",
    DeleteNode => "delete_node",
    DeleteVideoFiles => "delete_video_files",
    DeleteImageFiles => "delete_image_files",
    DeleteNodesUndoable => "delete_nodes_undoable",
    RestoreDeletedNodes => "restore_deleted_nodes",
    ReplaceNodeAndDeleteUndoable => "replace_node_and_delete_undoable",
    RestoreNodeReplacement => "restore_node_replacement",
    CreateEdge => "create_edge",
    DeleteEdge => "delete_edge",
    ListWorkflowModules => "list_workflow_modules",
    SaveWorkflowModule => "save_workflow_module",
    ValidateWorkflowModuleSource => "validate_workflow_module_source",
    TrashWorkflowModule => "trash_workflow_module",
    RestoreWorkflowModule => "restore_workflow_module",
    PurgeWorkflowModule => "purge_workflow_module",
    RestoreWorkflowModuleBackup => "restore_workflow_module_backup",
    ExportWorkflowModule => "export_workflow_module",
    ImportWorkflowModuleBundle => "import_workflow_module_bundle",
    RestoreWorkflowModuleBundle => "restore_workflow_module_bundle",
    GetComfyuiKrea2DiffusionModels => "get_comfyui_krea2_diffusion_models",
    GetComfyuiH3Loras => "get_comfyui_h3_loras",
    GetComfyuiKrea2Loras => "get_comfyui_krea2_loras",
    GetComfyuiH3DiffusionModels => "get_comfyui_h3_diffusion_models",
    SubmitComfyuiImageWorkflow => "submit_comfyui_image_workflow",
    SubmitComfyuiImageUpscale => "submit_comfyui_image_upscale",
    SubmitComfyuiWorkflow => "submit_comfyui_workflow",
    GetComfyuiQueueSummary => "get_comfyui_queue_summary",
    GetComfyuiClientTaskStatuses => "get_comfyui_client_task_statuses",
    CancelComfyuiWorkflow => "cancel_comfyui_workflow",
    GetRuntimeInfo => "get_runtime_info",
    SubmitComfyuiVideoUpscale => "submit_comfyui_video_upscale",
    CaptureVideoPoster => "capture_video_poster",
}

impl Command {
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|command| command.name() == name)
    }
}

fn input<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T, String> {
    argument(args, "input")
}

// Commands without a canvas id act on the global "active canvas" (desktop and
// /v1 behaviour). On the Web only admins may rely on it.
fn canvas_or_active(
    active_canvas: &RwLock<String>,
    session: &Session,
    canvas_id: Option<String>,
) -> Result<String, String> {
    match canvas_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => Ok(id),
        None if session.role == Role::Admin => active_canvas
            .read()
            .map(|id| id.clone())
            .map_err(|_| "active project lock is poisoned".to_owned()),
        None => Err("缺少画布 id".to_owned()),
    }
}

fn nodes_in(canvas: String, nodes: Vec<String>, scope: NodeScope) -> Permission {
    Permission::Nodes {
        canvas: Some(canvas),
        nodes,
        scope,
    }
}

fn node_records(refs: &mut RecordRefs, nodes: &[NodeRecord]) {
    for node in nodes {
        refs.nodes.push(node.id.clone());
        refs.canvases.push(node.canvas_id.clone());
    }
}
fn edge_records(refs: &mut RecordRefs, edges: &[EdgeRecord]) {
    for edge in edges {
        refs.edges.push(edge.id.clone());
        refs.canvases.push(edge.canvas_id.clone());
        refs.nodes.push(edge.source_node_id.clone());
        refs.nodes.push(edge.target_node_id.clone());
    }
}
fn binding_records(refs: &mut RecordRefs, bindings: &[PromptSceneBindingRecord]) {
    for binding in bindings {
        refs.canvases.push(binding.canvas_id.clone());
        refs.nodes.push(binding.node_id.clone());
    }
}
fn batch_records(refs: &mut RecordRefs, batch: &DeletedBatch) {
    node_records(refs, &batch.nodes);
    edge_records(refs, &batch.edges);
    binding_records(refs, &batch.prompt_scene_bindings);
}
fn source_records(refs: &mut RecordRefs, source: &FolderMergeSourceSnapshot) {
    node_records(refs, std::slice::from_ref(&source.folder_node));
    refs.canvases.push(source.child_canvas.id.clone());
    node_records(refs, &source.nodes);
    edge_records(refs, &source.edges);
    binding_records(refs, &source.prompt_scene_bindings);
}

// Every id an undo/restore payload names (CANVAS-012b: checked one by one).
pub fn grouping_refs(record: &FolderGroupingUndoRecord) -> RecordRefs {
    let mut refs = RecordRefs {
        anchor: record.parent_canvas_id.clone(),
        ..RecordRefs::default()
    };
    refs.canvases.push(record.child_canvas_id.clone());
    refs.nodes.push(record.folder_node_id.clone());
    node_records(&mut refs, &record.nodes);
    edge_records(&mut refs, &record.edges);
    binding_records(&mut refs, &record.prompt_scene_bindings);
    for duplicate in &record.duplicated_input_nodes {
        refs.nodes.push(duplicate.source_node_id.clone());
        refs.nodes.push(duplicate.duplicate_node_id.clone());
    }
    refs
}
pub fn merge_refs(record: &FolderMergeUndoRecord) -> RecordRefs {
    let mut refs = RecordRefs {
        anchor: record.parent_canvas_id.clone(),
        ..RecordRefs::default()
    };
    refs.canvases.push(record.merged_child_canvas_id.clone());
    refs.nodes.push(record.merged_folder_node_id.clone());
    for source in &record.sources {
        source_records(&mut refs, source);
    }
    edge_records(&mut refs, &record.parent_edges);
    for deduplicated in &record.deduplicated_input_nodes {
        refs.nodes
            .push(deduplicated.original_source_node_id.clone());
        refs.nodes.push(deduplicated.kept_node_id.clone());
        refs.nodes
            .extend(deduplicated.removed_node_ids.iter().cloned());
    }
    refs
}
pub fn cancel_refs(record: &CancelFolderUndoRecord) -> RecordRefs {
    let mut refs = RecordRefs {
        anchor: record.parent_canvas_id.clone(),
        ..RecordRefs::default()
    };
    source_records(&mut refs, &record.source);
    edge_records(&mut refs, &record.parent_edges);
    edge_records(&mut refs, &record.restored_source_edges);
    refs
}
pub fn tree_refs(record: &FolderTreeUndoRecord) -> RecordRefs {
    let mut refs = RecordRefs {
        anchor: record.parent_canvas_id.clone(),
        ..RecordRefs::default()
    };
    refs.nodes.push(record.root_folder_node_id.clone());
    refs.canvases
        .extend(record.canvases.iter().map(|canvas| canvas.id.clone()));
    node_records(&mut refs, &record.nodes);
    edge_records(&mut refs, &record.edges);
    for link in &record.folder_links {
        refs.nodes.push(link.folder_node_id.clone());
        refs.canvases.push(link.child_canvas_id.clone());
    }
    binding_records(&mut refs, &record.prompt_scene_bindings);
    refs
}
pub fn batch_refs(batch: &DeletedBatch) -> Result<RecordRefs, String> {
    let anchor = batch
        .nodes
        .first()
        .map(|node| node.canvas_id.clone())
        .ok_or("deleted batch contains no nodes")?;
    let mut refs = RecordRefs {
        anchor,
        ..RecordRefs::default()
    };
    batch_records(&mut refs, batch);
    Ok(refs)
}
pub fn replacement_refs(input: &RestoreNodeReplacementInput) -> RecordRefs {
    let mut refs = RecordRefs {
        anchor: input.previous_node.canvas_id.clone(),
        ..RecordRefs::default()
    };
    node_records(&mut refs, std::slice::from_ref(&input.previous_node));
    batch_records(&mut refs, &input.deleted);
    refs
}

// The permission category of every command (see the classification table in
// shared/results/canvas-012b1-authz.md). Ids that only name a node or edge are
// resolved to their canvas by the check.
pub fn permissions(
    active_canvas: &RwLock<String>,
    session: &Session,
    command: Command,
    args: &Value,
) -> Result<Vec<Permission>, String> {
    use Command::*;
    Ok(match command {
        // Global resources: admin only.
        ExportAppBackup
        | StageAppBackupRestore
        | SaveWorkflowModule
        | ValidateWorkflowModuleSource
        | TrashWorkflowModule
        | RestoreWorkflowModule
        | PurgeWorkflowModule
        | RestoreWorkflowModuleBackup
        | ExportWorkflowModule
        | ImportWorkflowModuleBundle
        | RestoreWorkflowModuleBundle
        | SetProjectPrivate
        // Any project, other users' private ones included, without edit mode;
        // always audited (architect, 012c2 item 1).
        | AdminDeleteProject
        // Owner change needs Admin, the sharing switch was already Admin:
        // the stricter of the two is Admin (012c2 rework).
        | UpdateCanvasSettings
        // Permanently deleting generated files stays admin-only until deletion
        // is checked against the canvases that reference each file.
        | DeleteVideoFiles
        | DeleteImageFiles
        // Orphan media of every user: listing names other users' files.
        | ListMediaCleanup
        | TrashMediaFiles
        | RestoreMediaFiles
        | PurgeMediaFiles => vec![Permission::Admin],
        // Users cancel the generations they started; admins cancel any.
        CancelComfyuiWorkflow => vec![Permission::TaskOwner(argument(args, "clientId")?)],
        // Global state: only the admin's is recorded; others get a no-op (see dispatch).
        TakeRestoredFrontendSettings | UpdateCanvasSelection => vec![Permission::Authenticated],
        // Shared tools; list results are filtered in SQL; generated files follow rule 4.
        GetAppLockStatus
        | ListProjects
        | ListProjectSummaries
        | CreateProject
        | ExportMediaAsset
        | ExportGeneratedVideo
        | ExportGeneratedImage
        | CleanupResizeImages
        | ListWorkflowModules
        | GetComfyuiKrea2DiffusionModels
        | GetComfyuiH3Loras
        | GetComfyuiKrea2Loras
        | GetComfyuiH3DiffusionModels
        | SubmitComfyuiImageWorkflow
        | SubmitComfyuiImageUpscale
        | SubmitComfyuiWorkflow
        | GetComfyuiQueueSummary
        | GetComfyuiClientTaskStatuses
        | GetRuntimeInfo
        | SubmitComfyuiVideoUpscale
        | CaptureVideoPoster => vec![Permission::Authenticated],
        VerifyAppLockPassword | SetAppLockPassword | DisableAppLock => {
            vec![Permission::Unavailable]
        }
        LoadWorkspace => vec![Permission::CanvasRead(canvas_or_active(
            active_canvas,
            session,
            argument(args, "canvasId")?,
        )?)],
        InspectWorkspace => vec![Permission::CanvasRead(argument(args, "canvasId")?)],
        UpdateProject => vec![Permission::CanvasWrite(
            input::<UpdateProjectInput>(args)?.id,
        )],
        DeleteProject => vec![Permission::CanvasDelete(argument(args, "id")?)],
        // Whoever may read a project may copy it; the copy is the caller's own
        // and private (012c2 rework). Read access is decided by the root.
        CopyProject => vec![Permission::CanvasRead(argument(args, "id")?)],
        // Being on a canvas is reading it, not writing: no edit mode, no audit,
        // so an admin viewing someone's private canvas read-only is shown too.
        PresenceHeartbeat => vec![Permission::CanvasRead(argument(args, "canvasId")?)],
        // Only ever removes the caller's own tab.
        PresenceLeave => vec![Permission::Authenticated],
        CreateEmptyFolder => vec![Permission::CanvasWrite(argument::<String>(
            &args["input"],
            "canvasId",
        )?)],
        ImportMedia => vec![Permission::CanvasWrite(argument(args, "canvasId")?)],
        CreateNode => {
            let node: CreateNodeInput = input(args)?;
            vec![Permission::CanvasWrite(canvas_or_active(
                active_canvas,
                session,
                node.canvas_id,
            )?)]
        }
        GroupNodesIntoFolder => {
            let group: GroupNodesIntoFolderInput = input(args)?;
            vec![nodes_in(
                group.canvas_id,
                group.node_ids,
                NodeScope::SameCanvas,
            )]
        }
        GroupRelatedNodesIntoFolder => {
            let group: GroupRelatedNodesIntoFolderInput = input(args)?;
            vec![nodes_in(
                group.canvas_id,
                vec![group.root_node_id],
                NodeScope::SameCanvas,
            )]
        }
        MergeFolders => {
            let merge: MergeFoldersInput = input(args)?;
            vec![nodes_in(
                merge.canvas_id,
                merge.folder_node_ids,
                NodeScope::SameCanvas,
            )]
        }
        CancelFolder | DeleteFolderTree => {
            let folder: FolderActionInput = input(args)?;
            vec![nodes_in(
                folder.canvas_id,
                vec![folder.folder_node_id],
                NodeScope::SameCanvas,
            )]
        }
        SetProjectPreviewImage => {
            let preview: SetProjectPreviewImageInput = input(args)?;
            vec![nodes_in(
                preview.project_id,
                vec![preview.image_node_id],
                NodeScope::SameTree,
            )]
        }
        ResizeImage => vec![nodes_in(
            argument(args, "canvasId")?,
            vec![argument(args, "sourceNodeId")?],
            NodeScope::SameTree,
        )],
        UpdateNode => vec![Permission::Nodes {
            canvas: None,
            nodes: vec![input::<UpdateNodeInput>(args)?.id],
            scope: NodeScope::SameTree,
        }],
        DeleteNode => vec![Permission::Nodes {
            canvas: None,
            nodes: vec![argument(args, "id")?],
            scope: NodeScope::SameTree,
        }],
        DeleteNodesUndoable => vec![Permission::Nodes {
            canvas: None,
            nodes: input::<DeleteNodesInput>(args)?.ids,
            scope: NodeScope::SameTree,
        }],
        ReplaceNodeAndDeleteUndoable => {
            let replace: ReplaceNodeAndDeleteInput = input(args)?;
            let mut nodes = vec![replace.update.id];
            nodes.extend(replace.delete_ids);
            vec![Permission::Nodes {
                canvas: None,
                nodes,
                scope: NodeScope::SameTree,
            }]
        }
        CreateEdge => {
            let edge: CreateEdgeInput = input(args)?;
            let nodes = vec![edge.source_node_id, edge.target_node_id];
            match edge.canvas_id {
                Some(canvas) => vec![nodes_in(canvas, nodes, NodeScope::SameCanvas)],
                None => vec![Permission::Nodes {
                    canvas: None,
                    nodes,
                    scope: NodeScope::SameTree,
                }],
            }
        }
        DeleteEdge => vec![Permission::EdgeWrite(argument(args, "id")?)],
        RestoreDeletedNodes => vec![Permission::Records(batch_refs(&argument(args, "batch")?)?)],
        RestoreNodeReplacement => vec![Permission::Records(replacement_refs(&input(args)?))],
        UndoFolderGrouping => vec![Permission::Records(grouping_refs(
            &input::<UndoFolderGroupingInput>(args)?.grouping,
        ))],
        UndoFolderMerge => vec![Permission::Records(merge_refs(
            &input::<UndoFolderMergeInput>(args)?.merge,
        ))],
        UndoCancelFolder => vec![Permission::Records(cancel_refs(
            &input::<UndoCancelFolderInput>(args)?.cancellation,
        ))],
        UndoDeleteFolderTree => vec![Permission::Records(tree_refs(
            &input::<UndoDeleteFolderInput>(args)?.deletion,
        ))],
    })
}

// The ComfyUI client id a submission runs under (its initiator may cancel it).
pub fn submitted_client_id(command: Command, args: &Value) -> Option<String> {
    use Command::*;
    match command {
        SubmitComfyuiImageWorkflow
        | SubmitComfyuiImageUpscale
        | SubmitComfyuiWorkflow
        | SubmitComfyuiVideoUpscale => args["input"]["clientId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        _ => None,
    }
}

fn listed(state: &WebState, session: &Session, summaries: bool) -> Result<Value, String> {
    let (condition, parameters) = Ownership::list_condition(&session.user_id);
    serde_json::to_value(
        state
            .core
            .database
            .list_projects_where(condition, &parameters, summaries)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn actor_username(state: &WebState, session: &Session) -> Result<String, String> {
    state
        .auth
        .users()
        .by_id(&session.user_id)?
        .map(|credential| credential.user.username)
        .ok_or_else(|| "用户不存在".to_owned())
}

#[derive(Clone, Copy)]
enum MediaAction {
    Trash,
    Restore,
    Purge,
}

// CANVAS-012c4: moves, restores or purges the named files on a blocking
// thread. The registry re-checks every file itself (registered, unreferenced
// past the grace period, inside a media root); the request only names them.
async fn media_action(
    state: &WebState,
    session: &Session,
    args: &Value,
    action: MediaAction,
) -> Result<Value, String> {
    let references: Vec<String> = argument(args, "references")?;
    let username = actor_username(state, session)?;
    let user_id = session.user_id.clone();
    let media = state.media.clone();
    let roots = state.media_roots();
    let outcome = tokio::task::spawn_blocking(move || {
        let actor = Actor {
            id: &user_id,
            username: &username,
        };
        let now = chrono::Utc::now();
        match action {
            MediaAction::Trash => media.trash(&actor, &roots, &references, now),
            MediaAction::Restore => media.restore(&actor, &roots, &references, now),
            MediaAction::Purge => media.purge(&actor, &roots, &references),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    serde_json::to_value(outcome).map_err(|e| e.to_string())
}

// CANVAS-012c3: after a project was deleted, moved or re-shared, tell each
// user whose access changed (their tabs only): open views close on
// "deleted"/"revoked", home lists refresh. Users who never had access hear nothing.
fn notify_access_change(state: &WebState, before: &CanvasOwner, after: Option<&CanvasOwner>) {
    let Ok(users) = state.auth.users().list() else {
        return;
    };
    fn readers(owner: &CanvasOwner) -> canvases::Readers<'_> {
        canvases::Readers {
            owner: owner.owner_user_id.as_deref(),
            shared: owner.is_shared,
        }
    }
    for (user, reason) in canvases::access_changes(readers(before), after.map(readers), &users) {
        let _ = state.handle.emit_to_user(
            canvases::ACCESS_EVENT,
            &user,
            serde_json::json!({"canvasId": before.root_id, "reason": reason}),
        );
    }
}

fn project_owner(state: &WebState, id: &str) -> Result<CanvasOwner, String> {
    state
        .auth
        .ownership()
        .owner(id)?
        .ok_or_else(|| "画布不存在".to_owned())
}

// Runs a command whose permissions were already granted.
pub async fn dispatch(
    state: &WebState,
    session: &Session,
    command: Command,
    args: &Value,
) -> Result<Value, String> {
    let admin = session.role == Role::Admin;
    match command {
        Command::ExportAppBackup => serde_json::to_value(
            commands::export_app_backup(
                argument(args, "destinationPath")?,
                argument(args, "frontendSettings")?,
                State(&state.core),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::StageAppBackupRestore => serde_json::to_value(
            commands::stage_app_backup_restore(argument(args, "bundlePath")?, State(&state.core))
                .await?,
        )
        .map_err(|e| e.to_string()),
        // Restored settings are applied by the admin; other users must not consume them.
        Command::TakeRestoredFrontendSettings if !admin => Ok(Value::Null),
        Command::TakeRestoredFrontendSettings => serde_json::to_value(
            commands::take_restored_frontend_settings(State(&state.core))?,
        )
        .map_err(|e| e.to_string()),
        Command::GetAppLockStatus => {
            serde_json::to_value(commands::get_app_lock_status(State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        // Unreachable on the Web: their category is Permission::Unavailable,
        // which is refused before dispatch. Kept as the plain command mapping.
        Command::VerifyAppLockPassword => serde_json::to_value(
            commands::verify_app_lock_password(argument(args, "password")?, State(&state.core))
                .await?,
        )
        .map_err(|e| e.to_string()),
        Command::SetAppLockPassword => serde_json::to_value(
            commands::set_app_lock_password(argument(args, "input")?, State(&state.core)).await?,
        )
        .map_err(|e| e.to_string()),
        Command::DisableAppLock => serde_json::to_value(
            commands::disable_app_lock(argument(args, "password")?, State(&state.core)).await?,
        )
        .map_err(|e| e.to_string()),
        Command::LoadWorkspace if !admin => {
            // Other users' navigation must not move the /v1 "active canvas".
            let canvas_id = canvas_or_active(
                &state.core.active_canvas_id,
                session,
                argument(args, "canvasId")?,
            )?;
            serde_json::to_value(
                state
                    .core
                    .database
                    .load_project(&canvas_id)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        Command::LoadWorkspace => serde_json::to_value(commands::load_workspace(
            argument(args, "canvasId")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::UpdateCanvasSelection if !admin => Ok(Value::Null),
        Command::UpdateCanvasSelection => serde_json::to_value(commands::update_canvas_selection(
            argument(args, "canvasId")?,
            argument(args, "nodeIds")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::InspectWorkspace => serde_json::to_value(commands::inspect_workspace(
            argument(args, "canvasId")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        // Admins see every root project; everyone else gets the SQL-filtered list.
        Command::ListProjects if admin => {
            serde_json::to_value(commands::list_projects(State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::ListProjectSummaries if admin => {
            serde_json::to_value(commands::list_project_summaries(State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::ListProjects => listed(state, session, false),
        Command::ListProjectSummaries => listed(state, session, true),
        Command::CreateProject => {
            let snapshot = commands::create_project(input(args)?, State(&state.core))?;
            let shared = args["input"]["shared"].as_bool().unwrap_or(false);
            state
                .auth
                .ownership()
                .assign(&snapshot.canvas.id, &session.user_id, shared)?;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        Command::GroupNodesIntoFolder => serde_json::to_value(commands::group_nodes_into_folder(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::CreateEmptyFolder => serde_json::to_value(commands::create_empty_folder(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::GroupRelatedNodesIntoFolder => serde_json::to_value(
            commands::group_related_nodes_into_folder(input(args)?, State(&state.core))?,
        )
        .map_err(|e| e.to_string()),
        Command::UndoFolderGrouping => serde_json::to_value(commands::undo_folder_grouping(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::MergeFolders => {
            serde_json::to_value(commands::merge_folders(input(args)?, State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::UndoFolderMerge => serde_json::to_value(commands::undo_folder_merge(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::CancelFolder => {
            serde_json::to_value(commands::cancel_folder(input(args)?, State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::UndoCancelFolder => serde_json::to_value(commands::undo_cancel_folder(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::DeleteFolderTree => serde_json::to_value(commands::delete_folder_tree(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::UndoDeleteFolderTree => serde_json::to_value(commands::undo_delete_folder_tree(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::UpdateProject => {
            serde_json::to_value(commands::update_project(input(args)?, State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::SetProjectPrivate => serde_json::to_value(commands::set_project_private(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::SetProjectPreviewImage => serde_json::to_value(
            commands::set_project_preview_image(input(args)?, State(&state.core))?,
        )
        .map_err(|e| e.to_string()),
        Command::DeleteProject => {
            let id: String = argument(args, "id")?;
            let before = project_owner(state, &id)?;
            // Media files stay; the orphan cleanup decides about them (012c4).
            commands::delete_project_records(&id, &state.core)?;
            let result = Value::Null;
            if before.root_id == id {
                notify_access_change(state, &before, None);
            }
            Ok(result)
        }
        Command::AdminDeleteProject => {
            let before = project_owner(state, &argument::<String>(args, "id")?)?;
            let username = actor_username(state, session)?;
            let actor = Actor {
                id: &session.user_id,
                username: &username,
            };
            let deleted = canvases::admin_delete(
                state.auth.ownership(),
                &actor,
                &argument::<String>(args, "id")?,
            )?;
            // Same /v1 fallback as the desktop delete_project. Media files
            // are deliberately left alone (CANVAS-012c4 handles them).
            let mut active = state
                .core
                .active_canvas_id
                .write()
                .map_err(|_| "active project lock is poisoned".to_owned())?;
            if *active == deleted.id {
                *active = state
                    .core
                    .database
                    .list_projects()
                    .map_err(|e| e.to_string())?
                    .first()
                    .map(|project| project.canvas.id.clone())
                    .unwrap_or_else(|| crate::models::DEFAULT_CANVAS_ID.to_owned());
            }
            drop(active);
            notify_access_change(state, &before, None);
            serde_json::to_value(deleted).map_err(|e| e.to_string())
        }
        Command::UpdateCanvasSettings => {
            let id: String = argument(args, "id")?;
            let before = project_owner(state, &id)?;
            let username = actor_username(state, session)?;
            let actor = Actor {
                id: &session.user_id,
                username: &username,
            };
            let owner = canvases::update_settings(
                state.auth.ownership(),
                &actor,
                &id,
                argument::<Option<String>>(args, "ownerUserId")?.as_deref(),
                argument::<Option<bool>>(args, "isShared")?,
            )?;
            notify_access_change(state, &before, Some(&owner));
            Ok(serde_json::json!({
                "rootCanvasId": owner.root_id,
                "ownerUserId": owner.owner_user_id,
                "isShared": owner.is_shared,
            }))
        }
        Command::CopyProject => {
            let copy = canvases::copy_project(
                state.auth.ownership(),
                &session.user_id,
                &argument::<String>(args, "id")?,
            )?;
            serde_json::to_value(
                state
                    .core
                    .database
                    .load_project(&copy)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        Command::PresenceHeartbeat => {
            let user = state
                .auth
                .users()
                .by_id(&session.user_id)?
                .ok_or_else(|| "用户不存在".to_owned())?
                .user;
            let users = state.presence.heartbeat(
                &argument::<String>(args, "canvasId")?,
                &argument::<String>(args, "tabId")?,
                presence::PresentUser {
                    user_id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                },
                std::time::Instant::now(),
            );
            Ok(serde_json::json!({
                "users": users,
                "heartbeatSeconds": presence::HEARTBEAT_SECONDS,
                "timeoutSeconds": presence::TIMEOUT_SECONDS,
            }))
        }
        Command::PresenceLeave => {
            state
                .presence
                .leave(&session.user_id, &argument::<String>(args, "tabId")?);
            Ok(Value::Null)
        }
        Command::ListMediaCleanup => {
            let media = state.media.clone();
            let roots = state.media_roots();
            let listing =
                tokio::task::spawn_blocking(move || media.list(&roots, chrono::Utc::now()))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(listing).map_err(|e| e.to_string())
        }
        Command::TrashMediaFiles => media_action(state, session, args, MediaAction::Trash).await,
        Command::RestoreMediaFiles => {
            media_action(state, session, args, MediaAction::Restore).await
        }
        Command::PurgeMediaFiles => media_action(state, session, args, MediaAction::Purge).await,
        Command::CreateNode => {
            let mut node: CreateNodeInput = input(args)?;
            // A missing canvas id means the active canvas (admins only, see permissions).
            node.canvas_id = Some(canvas_or_active(
                &state.core.active_canvas_id,
                session,
                node.canvas_id,
            )?);
            serde_json::to_value(commands::create_node(node, State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::ImportMedia => serde_json::to_value(
            commands::import_media(
                argument(args, "path")?,
                argument(args, "canvasId")?,
                argument(args, "x")?,
                argument(args, "y")?,
                State(&state.core),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::ExportMediaAsset => serde_json::to_value(
            commands::export_media_asset(
                argument(args, "sourcePath")?,
                argument(args, "destinationPath")?,
                State(&state.core),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::ExportGeneratedVideo => serde_json::to_value(
            commands::export_generated_video(
                argument(args, "sourcePath")?,
                argument(args, "destinationPath")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::ExportGeneratedImage => serde_json::to_value(
            commands::export_generated_image(
                argument(args, "sourcePath")?,
                argument(args, "destinationPath")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        // CANVAS-012c4: nobody deletes Resize files right away on the Web.
        // Unreferenced ones start their grace period and reach the admin's
        // cleanup list later; nothing is removed now, hence 0.
        Command::CleanupResizeImages => {
            state.refresh_media(Some(session.user_id.clone()));
            Ok(Value::from(0))
        }
        Command::ResizeImage => serde_json::to_value(
            commands::resize_image(
                argument(args, "sourceNodeId")?,
                argument(args, "sourcePath")?,
                argument(args, "originalName")?,
                argument(args, "canvasId")?,
                argument(args, "maxEdge")?,
                argument(args, "x")?,
                argument(args, "y")?,
                argument(args, "width")?,
                argument(args, "height")?,
                State(&state.core),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::UpdateNode => {
            serde_json::to_value(commands::update_node(input(args)?, State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::DeleteNode => serde_json::to_value(commands::delete_node(
            argument(args, "id")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::DeleteVideoFiles => {
            serde_json::to_value(commands::delete_video_files(argument(args, "paths")?).await?)
                .map_err(|e| e.to_string())
        }
        Command::DeleteImageFiles => {
            serde_json::to_value(commands::delete_image_files(argument(args, "paths")?).await?)
                .map_err(|e| e.to_string())
        }
        Command::DeleteNodesUndoable => serde_json::to_value(commands::delete_nodes_undoable(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::RestoreDeletedNodes => serde_json::to_value(commands::restore_deleted_nodes(
            argument(args, "batch")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::ReplaceNodeAndDeleteUndoable => serde_json::to_value(
            commands::replace_node_and_delete_undoable(input(args)?, State(&state.core))?,
        )
        .map_err(|e| e.to_string()),
        Command::RestoreNodeReplacement => serde_json::to_value(
            commands::restore_node_replacement(input(args)?, State(&state.core))?,
        )
        .map_err(|e| e.to_string()),
        Command::CreateEdge => {
            serde_json::to_value(commands::create_edge(input(args)?, State(&state.core))?)
                .map_err(|e| e.to_string())
        }
        Command::DeleteEdge => serde_json::to_value(commands::delete_edge(
            argument(args, "id")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::ListWorkflowModules => serde_json::to_value(commands::list_workflow_modules(
            state.handle.clone(),
            argument(args, "includeDeleted")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::SaveWorkflowModule => serde_json::to_value(commands::save_workflow_module(
            input(args)?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::ValidateWorkflowModuleSource => {
            serde_json::to_value(commands::validate_workflow_module_source(
                argument(args, "sourceWorkflowPath")?,
                argument(args, "AdapterKind")?,
                argument(args, "variant")?,
                argument(args, "bindings")?,
                argument(args, "adapter")?,
                argument(args, "uiSchema")?,
            )?)
            .map_err(|e| e.to_string())
        }
        Command::TrashWorkflowModule => serde_json::to_value(commands::trash_workflow_module(
            argument(args, "id")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::RestoreWorkflowModule => serde_json::to_value(commands::restore_workflow_module(
            argument(args, "id")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::PurgeWorkflowModule => serde_json::to_value(commands::purge_workflow_module(
            argument(args, "id")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::RestoreWorkflowModuleBackup => serde_json::to_value(
            commands::restore_workflow_module_backup(argument(args, "id")?, State(&state.core))?,
        )
        .map_err(|e| e.to_string()),
        Command::ExportWorkflowModule => serde_json::to_value(commands::export_workflow_module(
            argument(args, "id")?,
            State(&state.core),
        )?)
        .map_err(|e| e.to_string()),
        Command::ImportWorkflowModuleBundle => {
            serde_json::to_value(commands::import_workflow_module_bundle(
                argument(args, "bundlePath")?,
                State(&state.core),
            )?)
            .map_err(|e| e.to_string())
        }
        Command::RestoreWorkflowModuleBundle => {
            serde_json::to_value(commands::restore_workflow_module_bundle(
                argument(args, "id")?,
                argument(args, "bundlePath")?,
                State(&state.core),
            )?)
            .map_err(|e| e.to_string())
        }
        Command::GetComfyuiKrea2DiffusionModels => serde_json::to_value(
            commands::get_comfyui_krea2_diffusion_models(
                argument(args, "serverUrl")?,
                argument(args, "workflowModuleId")?,
                State(&state.core),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::GetComfyuiH3Loras => serde_json::to_value(
            commands::get_comfyui_h3_loras(argument(args, "serverUrl")?).await?,
        )
        .map_err(|e| e.to_string()),
        Command::GetComfyuiKrea2Loras => serde_json::to_value(
            commands::get_comfyui_krea2_loras(argument(args, "serverUrl")?).await?,
        )
        .map_err(|e| e.to_string()),
        Command::GetComfyuiH3DiffusionModels => serde_json::to_value(
            commands::get_comfyui_h3_diffusion_models(
                argument(args, "serverUrl")?,
                argument(args, "workflowModuleId")?,
                State(&state.core),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::SubmitComfyuiImageWorkflow => serde_json::to_value(
            commands::submit_comfyui_image_workflow(input(args)?, State(&state.core)).await?,
        )
        .map_err(|e| e.to_string()),
        Command::SubmitComfyuiImageUpscale => serde_json::to_value(
            commands::submit_comfyui_image_upscale(input(args)?, State(&state.core)).await?,
        )
        .map_err(|e| e.to_string()),
        Command::SubmitComfyuiWorkflow => serde_json::to_value(
            commands::submit_comfyui_workflow(
                input(args)?,
                State(&state.core),
                Channel::new(channel(state, args, &session.user_id)),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::GetComfyuiQueueSummary => serde_json::to_value(
            commands::get_comfyui_queue_summary(argument(args, "serverUrl")?).await?,
        )
        .map_err(|e| e.to_string()),
        Command::GetComfyuiClientTaskStatuses => serde_json::to_value(
            commands::get_comfyui_client_task_statuses(
                argument(args, "serverUrl")?,
                argument(args, "clientIds")?,
                argument(args, "imageClientIds")?,
                argument(args, "videoOutputNodeIds")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::CancelComfyuiWorkflow => serde_json::to_value(
            commands::cancel_comfyui_workflow(
                argument(args, "serverUrl")?,
                argument(args, "clientId")?,
                State(&state.core),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::GetRuntimeInfo => {
            serde_json::to_value(commands::get_runtime_info(State(&state.core)))
                .map_err(|e| e.to_string())
        }
        Command::SubmitComfyuiVideoUpscale => serde_json::to_value(
            video_upscale::submit_comfyui_video_upscale(
                input(args)?,
                State(&state.core),
                Channel::new(channel(state, args, &session.user_id)),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        Command::CaptureVideoPoster => {
            serde_json::to_value(super::posters::capture(state, argument(args, "source")?).await?)
                .map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::authz::tests::{canvas_json, node_json, session, source_json};
    use super::*;
    use serde_json::json;

    // Desktop commands deliberately not offered on the Web.
    const NOT_ON_WEB: &[&str] = &[];

    fn desktop_commands() -> Vec<String> {
        let mut names = Vec::new();
        for source in [
            include_str!("../commands.rs"),
            include_str!("../video_upscale.rs"),
        ] {
            let mut pending = false;
            for line in source.lines() {
                let line = line.trim();
                if line.starts_with("#[cfg_attr(feature = \"desktop\", tauri::command") {
                    pending = true;
                } else if pending {
                    if let Some(rest) = line
                        .strip_prefix("pub async fn ")
                        .or_else(|| line.strip_prefix("pub fn "))
                    {
                        names.push(rest.split('(').next().unwrap().to_owned());
                        pending = false;
                    }
                }
            }
        }
        names
    }

    fn kind(permission: &Permission) -> &'static str {
        match permission {
            Permission::Admin => "admin",
            Permission::Authenticated => "authenticated",
            Permission::Unavailable => "unavailable",
            Permission::CanvasRead(_) => "canvas-read",
            Permission::CanvasWrite(_) => "canvas-write",
            Permission::CanvasDelete(_) => "canvas-delete",
            Permission::Nodes { .. } => "nodes",
            Permission::EdgeWrite(_) => "edge",
            Permission::Records(_) => "records",
            Permission::TaskOwner(_) => "task-owner",
        }
    }

    // The classification table (also in the 012b-1 report): command, sample
    // arguments, expected category. Every command must appear here.
    fn table() -> Vec<(&'static str, Value, &'static str)> {
        let node = |id: &str| node_json(id, "canvas:a");
        let none = json!({});
        let mut rows = vec![];
        for name in [
            "export_app_backup",
            "stage_app_backup_restore",
            "save_workflow_module",
            "validate_workflow_module_source",
            "trash_workflow_module",
            "restore_workflow_module",
            "purge_workflow_module",
            "restore_workflow_module_backup",
            "export_workflow_module",
            "import_workflow_module_bundle",
            "restore_workflow_module_bundle",
            "set_project_private",
            "admin_delete_project",
            "update_canvas_settings",
            "delete_video_files",
            "delete_image_files",
            "list_media_cleanup",
            "trash_media_files",
            "restore_media_files",
            "purge_media_files",
        ] {
            rows.push((name, none.clone(), "admin"));
        }
        rows.push((
            "cancel_comfyui_workflow",
            json!({"clientId": "client-1"}),
            "task-owner",
        ));
        for name in [
            "take_restored_frontend_settings",
            "update_canvas_selection",
            "get_app_lock_status",
            "list_projects",
            "list_project_summaries",
            "create_project",
            "export_media_asset",
            "export_generated_video",
            "export_generated_image",
            "cleanup_resize_images",
            "list_workflow_modules",
            "get_comfyui_krea2_diffusion_models",
            "get_comfyui_h3_loras",
            "get_comfyui_krea2_loras",
            "get_comfyui_h3_diffusion_models",
            "submit_comfyui_image_workflow",
            "submit_comfyui_image_upscale",
            "submit_comfyui_workflow",
            "get_comfyui_queue_summary",
            "get_comfyui_client_task_statuses",
            "get_runtime_info",
            "submit_comfyui_video_upscale",
            "capture_video_poster",
            "presence_leave",
        ] {
            rows.push((name, none.clone(), "authenticated"));
        }
        for name in [
            "verify_app_lock_password",
            "set_app_lock_password",
            "disable_app_lock",
        ] {
            rows.push((name, none.clone(), "unavailable"));
        }
        rows.extend([
            ("load_workspace", json!({"canvasId": "canvas:a"}), "canvas-read"),
            ("inspect_workspace", json!({"canvasId": "canvas:a"}), "canvas-read"),
            ("copy_project", json!({"id": "canvas:a"}), "canvas-read"),
            ("presence_heartbeat", json!({"canvasId": "canvas:a", "tabId": "t"}), "canvas-read"),
            ("update_project", json!({"input": {"id": "canvas:a", "name": "n"}}), "canvas-write"),
            ("create_empty_folder", json!({"input": {"canvasId": "canvas:a", "x": 0.0, "y": 0.0}}), "canvas-write"),
            ("import_media", json!({"canvasId": "canvas:a"}), "canvas-write"),
            ("create_node", json!({"input": {"canvasId": "canvas:a"}}), "canvas-write"),
            ("delete_project", json!({"id": "canvas:a"}), "canvas-delete"),
            ("group_nodes_into_folder", json!({"input": {"canvasId": "canvas:a", "nodeIds": ["n1"]}}), "nodes"),
            ("group_related_nodes_into_folder", json!({"input": {"canvasId": "canvas:a", "rootNodeId": "n1"}}), "nodes"),
            ("merge_folders", json!({"input": {"canvasId": "canvas:a", "folderNodeIds": ["f1"]}}), "nodes"),
            ("cancel_folder", json!({"input": {"canvasId": "canvas:a", "folderNodeId": "f1"}}), "nodes"),
            ("delete_folder_tree", json!({"input": {"canvasId": "canvas:a", "folderNodeId": "f1"}}), "nodes"),
            ("set_project_preview_image", json!({"input": {"projectId": "canvas:a", "imageNodeId": "n1"}}), "nodes"),
            ("resize_image", json!({"canvasId": "canvas:a", "sourceNodeId": "n1"}), "nodes"),
            ("update_node", json!({"input": {"id": "n1"}}), "nodes"),
            ("delete_node", json!({"id": "n1"}), "nodes"),
            ("delete_nodes_undoable", json!({"input": {"ids": ["n1"]}}), "nodes"),
            ("replace_node_and_delete_undoable", json!({"input": {"update": {"id": "n1"}, "deleteIds": ["n2"]}}), "nodes"),
            ("create_edge", json!({"input": {"sourceNodeId": "n1", "targetNodeId": "n2", "metadata": {}}}), "nodes"),
            ("delete_edge", json!({"id": "e1"}), "edge"),
            ("restore_deleted_nodes", json!({"batch": {"nodes": [node("n1")], "edges": []}}), "records"),
            ("restore_node_replacement", json!({"input": {"previousNode": node("n1"), "deleted": {"nodes": [node("n2")], "edges": []}}}), "records"),
            ("undo_folder_grouping", json!({"input": {"grouping": {"parentCanvasId": "canvas:a", "childCanvasId": "canvas:b", "folderNodeId": "f1",
                "nodes": [], "edges": [], "promptSceneBindings": [], "duplicatedInputNodes": []}}}), "records"),
            ("undo_folder_merge", json!({"input": {"merge": {"parentCanvasId": "canvas:a", "mergedChildCanvasId": "canvas:b", "mergedFolderNodeId": "f1",
                "sources": [source_json(node("f2"), "canvas:c", vec![])], "parentEdges": [], "deduplicatedInputNodes": []}}}), "records"),
            ("undo_cancel_folder", json!({"input": {"cancellation": {"parentCanvasId": "canvas:a",
                "source": source_json(node("f2"), "canvas:c", vec![]), "parentEdges": [], "restoredSourceEdges": []}}}), "records"),
            ("undo_delete_folder_tree", json!({"input": {"deletion": {"parentCanvasId": "canvas:a", "rootFolderNodeId": "f1",
                "canvases": [canvas_json("canvas:b")], "nodes": [], "edges": [], "folderLinks": [], "promptSceneBindings": []}}}), "records"),
        ]);
        rows
    }

    #[test]
    fn every_command_declares_a_permission_category() {
        let mut names: Vec<_> = Command::ALL.iter().map(|command| command.name()).collect();
        assert_eq!(names.len(), Command::ALL.len());
        names.sort();
        names.dedup();
        assert_eq!(names.len(), Command::ALL.len(), "duplicate command names");
        for command in Command::ALL {
            assert_eq!(Command::parse(command.name()), Some(*command));
        }
        // Second line of defence next to the exhaustive matches: every
        // desktop command is either a Web command (and so classified) or
        // deliberately excluded.
        let desktop = desktop_commands();
        assert!(
            desktop.len() > 50,
            "parsed {} desktop commands",
            desktop.len()
        );
        for name in &desktop {
            assert!(
                Command::parse(name).is_some() || NOT_ON_WEB.contains(&name.as_str()),
                "desktop command {name} has no Web permission category"
            );
        }
        let table = table();
        let active = std::sync::RwLock::new("canvas:active".to_owned());
        for command in Command::ALL {
            let (_, args, expected) = table
                .iter()
                .find(|(name, _, _)| *name == command.name())
                .unwrap_or_else(|| {
                    panic!("{} missing from the classification table", command.name())
                });
            for actor in [session("u", Role::User), session("a", Role::Admin)] {
                let granted = permissions(&active, &actor, *command, args)
                    .unwrap_or_else(|error| panic!("{}: {error}", command.name()));
                assert!(
                    !granted.is_empty(),
                    "{} declares no permission",
                    command.name()
                );
                for permission in &granted {
                    assert_eq!(kind(permission), *expected, "{}", command.name());
                }
            }
        }
        assert_eq!(table.len(), Command::ALL.len());
    }

    // 012c3: a heartbeat is a read. A read-only admin (no edit mode) on someone
    // else's private canvas may send it, nothing is audited or written, and a
    // user who cannot read the canvas is refused as if it did not exist.
    #[test]
    fn presence_heartbeats_are_reads_even_for_read_only_admins() {
        let world = super::super::authz::tests::world();
        let alices = world.project(&world.alice, false);
        let active = std::sync::RwLock::new("canvas:active".to_owned());
        let args = json!({"canvasId": alices, "tabId": "t"});
        let granted =
            permissions(&active, &world.admin, Command::PresenceHeartbeat, &args).unwrap();
        assert_eq!(granted, vec![Permission::CanvasRead(alices.clone())]);
        assert!(world.admin.admin_edit_until.is_none());
        let grant = super::super::authz::check(world.store(), &world.admin, &granted[0]).unwrap();
        assert!(grant.audit.is_empty() && grant.written_roots.is_empty());
        assert!(matches!(
            super::super::authz::check(world.store(), &world.bob, &granted[0]),
            Err(super::super::authz::Denied::NotFound)
        ));
    }

    // c5 item 5: the old sharing command is gone from the Web (the UI uses
    // update_canvas_settings); there is no desktop command of that name.
    #[test]
    fn set_canvas_sharing_is_not_a_web_command() {
        assert_eq!(Command::parse("set_canvas_sharing"), None);
        assert!(!desktop_commands()
            .iter()
            .any(|name| name == "set_canvas_sharing"));
        assert_eq!(
            Command::parse("update_canvas_settings"),
            Some(Command::UpdateCanvasSettings)
        );
    }

    // 012c4: the orphan media commands are admin only (403 for everyone else,
    // whatever they name); a read-only admin may use them.
    #[test]
    fn media_cleanup_commands_are_admin_only() {
        let world = super::super::authz::tests::world();
        let active = std::sync::RwLock::new("canvas:active".to_owned());
        let args = json!({"references": ["sucanvas-input://sucanvas-imports/a.png"]});
        for command in [
            Command::ListMediaCleanup,
            Command::TrashMediaFiles,
            Command::RestoreMediaFiles,
            Command::PurgeMediaFiles,
        ] {
            for user in [&world.alice, &world.bob] {
                let granted = permissions(&active, user, command, &args).unwrap();
                assert_eq!(granted, vec![Permission::Admin]);
                let denied =
                    super::super::authz::check(world.store(), user, &granted[0]).unwrap_err();
                assert!(matches!(denied, super::super::authz::Denied::Forbidden(_)));
                assert_eq!(
                    axum::response::IntoResponse::into_response(denied).status(),
                    axum::http::StatusCode::FORBIDDEN
                );
            }
            assert!(world.admin.admin_edit_until.is_none());
            let granted = permissions(&active, &world.admin, command, &args).unwrap();
            assert!(super::super::authz::check(world.store(), &world.admin, &granted[0]).is_ok());
        }
    }

    #[test]
    fn active_canvas_defaults_are_admin_only() {
        let active = std::sync::RwLock::new("canvas:active".to_owned());
        let args = json!({"input": {"title": "n"}});
        assert!(permissions(
            &active,
            &session("u", Role::User),
            Command::CreateNode,
            &args
        )
        .is_err());
        assert_eq!(
            permissions(
                &active,
                &session("a", Role::Admin),
                Command::CreateNode,
                &args
            )
            .unwrap(),
            vec![Permission::CanvasWrite("canvas:active".into())]
        );
        assert!(permissions(
            &active,
            &session("u", Role::User),
            Command::LoadWorkspace,
            &json!({})
        )
        .is_err());
    }
}
