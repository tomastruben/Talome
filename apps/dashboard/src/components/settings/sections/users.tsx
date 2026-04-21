"use client";

import { useState } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon, Add01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { useUser } from "@/hooks/use-user";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";
import { FEATURE_PERMISSIONS, PERMISSION_LABELS, getDefaultPermissions } from "@talome/types";
import type { UserPermissions } from "@talome/types";

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  role: "admin" | "member";
  permissions: UserPermissions;
  createdAt: string;
  lastLoginAt: string | null;
}

function PermissionsGrid({
  permissions,
  onChange,
  disabled,
}: {
  permissions: UserPermissions;
  onChange: (next: UserPermissions) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
      {FEATURE_PERMISSIONS.map((key) => {
        const meta = PERMISSION_LABELS[key];
        const checked = permissions[key] !== false;
        return (
          <label
            key={key}
            className="flex items-center gap-2.5 py-1 cursor-pointer group"
          >
            <Switch
              checked={checked}
              disabled={disabled}
              onCheckedChange={(v) => onChange({ ...permissions, [key]: v })}
              className="scale-[0.8] origin-left"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium leading-tight">{meta.label}</p>
              <p className="text-xs text-muted-foreground leading-tight">{meta.description}</p>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function UserCard({
  u,
  isSelf,
  isLastAdmin,
  onMutate,
}: {
  u: UserRow;
  isSelf: boolean;
  isLastAdmin: boolean;
  onMutate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editUsername, setEditUsername] = useState(u.username);
  const [newPassword, setNewPassword] = useState("");
  const [editPermissions, setEditPermissions] = useState<UserPermissions>(u.permissions);
  const [saving, setSaving] = useState(false);

  const canChangeRole = !isSelf && !isLastAdmin;
  const canDelete = !isSelf && !(u.role === "admin" && isLastAdmin);
  const isAdmin = u.role === "admin";

  // Check if permissions differ from original
  const permissionsChanged = !isAdmin && FEATURE_PERMISSIONS.some(
    (key) => (editPermissions[key] !== false) !== (u.permissions[key] !== false),
  );

  async function handleSave() {
    setSaving(true);
    try {
      if (editUsername !== u.username) {
        const res = await fetch(`${CORE_URL}/api/users/${u.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ username: editUsername }),
        });
        if (!res.ok) {
          const data = await res.json() as { error?: string };
          toast.error(data.error ?? "Failed to update username");
          setSaving(false);
          return;
        }
      }

      if (newPassword) {
        const res = await fetch(`${CORE_URL}/api/users/${u.id}/reset-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ password: newPassword }),
        });
        if (!res.ok) {
          const data = await res.json() as { error?: string };
          toast.error(data.error ?? "Failed to reset password");
          setSaving(false);
          return;
        }
      }

      if (permissionsChanged) {
        const res = await fetch(`${CORE_URL}/api/users/${u.id}/permissions`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ permissions: editPermissions }),
        });
        if (!res.ok) {
          const data = await res.json() as { error?: string };
          toast.error(data.error ?? "Failed to update permissions");
          setSaving(false);
          return;
        }
      }

      toast.success("User updated");
      setNewPassword("");
      setExpanded(false);
      onMutate();
    } catch {
      toast.error("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleRoleToggle() {
    const nextRole = u.role === "admin" ? "member" : "admin";
    try {
      const res = await fetch(`${CORE_URL}/api/users/${u.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? "Failed to update role");
        return;
      }
      toast.success(`${u.username} is now ${nextRole}`);
      onMutate();
    } catch {
      toast.error("Network error");
    }
  }

  async function handleRegenerateRecoveryCode() {
    try {
      const res = await fetch(`${CORE_URL}/api/users/${u.id}/recovery-code`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? "Failed to generate code");
        return;
      }
      const data = await res.json() as { recoveryCode?: string };
      if (data.recoveryCode) {
        prompt(`Recovery code for ${u.username} — save it now (shown once):`, data.recoveryCode);
      }
    } catch {
      toast.error("Network error");
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${CORE_URL}/api/users/${u.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? "Failed to delete");
        return;
      }
      toast.success(`User "${u.username}" deleted`);
      onMutate();
    } catch {
      toast.error("Network error");
    }
  }

  const hasChanges = editUsername !== u.username || newPassword.length > 0 || permissionsChanged;

  // Count enabled permissions
  const enabledCount = FEATURE_PERMISSIONS.filter((k) => u.permissions[k] !== false).length;
  const totalCount = FEATURE_PERMISSIONS.length;

  return (
    <div>
      <button
        type="button"
        className="w-full px-4 py-3.5 flex items-center gap-3 text-left hover:bg-muted/20 transition-colors"
        onClick={() => {
          setExpanded((v) => !v);
          setEditUsername(u.username);
          setNewPassword("");
          setEditPermissions(u.permissions);
        }}
      >
        <div className="size-8 rounded-full bg-muted/60 flex items-center justify-center shrink-0 text-sm font-medium text-muted-foreground uppercase">
          {u.username[0]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{u.username}</span>
            <Badge variant={u.role === "admin" ? "default" : "secondary"} className="text-xs px-1.5 py-0">
              {u.role}
            </Badge>
            {isSelf && (
              <span className="text-xs text-muted-foreground">you</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {u.lastLoginAt ? `Active ${relativeTime(u.lastLoginAt)}` : `Created ${relativeTime(u.createdAt)}`}
            {!isAdmin && ` · ${enabledCount}/${totalCount} features`}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-0 grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`edit-name-${u.id}`} className="text-xs text-muted-foreground">Username</Label>
              <Input
                id={`edit-name-${u.id}`}
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`edit-pass-${u.id}`} className="text-xs text-muted-foreground">New password</Label>
              <Input
                id={`edit-pass-${u.id}`}
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Leave blank to keep"
                className="h-8 text-sm"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Admin</Label>
              <Switch
                checked={u.role === "admin"}
                disabled={!canChangeRole}
                onCheckedChange={() => handleRoleToggle()}
              />
            </div>
          </div>

          {!isAdmin && (
            <div className="pt-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                Feature Access
              </p>
              <PermissionsGrid
                permissions={editPermissions}
                onChange={setEditPermissions}
              />
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <div className="flex-1" />

            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={handleRegenerateRecoveryCode}
            >
              Recovery code
            </Button>

            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive/60 hover:text-destructive"
                onClick={handleDelete}
              >
                Delete
              </Button>
            )}

            <Button
              size="sm"
              className="h-7 text-xs px-4"
              disabled={saving || !hasChanges || (newPassword.length > 0 && newPassword.length < 8)}
              onClick={handleSave}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>

          {isSelf && (
            <p className="text-xs text-muted-foreground">
              You can&apos;t change your own role or delete yourself.
            </p>
          )}
          {!isSelf && isLastAdmin && u.role === "admin" && (
            <p className="text-xs text-muted-foreground">
              This is the only admin. Promote another user first.
            </p>
          )}
          {isAdmin && (
            <p className="text-xs text-muted-foreground">
              Admins have full access to all features. Permissions only apply to members.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function UsersSection() {
  const { isAdmin, user } = useUser();
  const { data: users, mutate } = useSWR<UserRow[]>(
    isAdmin ? `${CORE_URL}/api/users` : null,
    (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json()),
    { revalidateOnFocus: false },
  );

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "member">("member");
  const [newPermissions, setNewPermissions] = useState<UserPermissions>(getDefaultPermissions());
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);

  if (!isAdmin) return null;

  const adminCount = users?.filter((u) => u.role === "admin").length ?? 0;
  const memberUsers = users?.filter((u) => u.role === "member") ?? [];

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newUsername || !newPassword) return;
    setCreating(true);
    try {
      const res = await fetch(`${CORE_URL}/api/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          role: newRole,
          permissions: newRole === "member" ? newPermissions : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? "Failed to create user");
        return;
      }
      const data = await res.json() as { recoveryCode?: string };
      if (data.recoveryCode) {
        prompt(`Recovery code for ${newUsername} — save it now (shown once):`, data.recoveryCode);
      }
      toast.success(`User "${newUsername}" created`);
      setNewUsername("");
      setNewPassword("");
      setNewRole("member");
      setNewPermissions(getDefaultPermissions());
      setShowForm(false);
      mutate();
    } catch {
      toast.error("Network error");
    } finally {
      setCreating(false);
    }
  }

  async function handleBulkPermissions(permissions: UserPermissions) {
    const ids = memberUsers.map((u) => u.id);
    if (ids.length === 0) return;

    try {
      const res = await fetch(`${CORE_URL}/api/users/bulk-permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userIds: ids, permissions }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? "Failed to update permissions");
        return;
      }
      const data = await res.json() as { updated: number };
      toast.success(`Updated permissions for ${data.updated} user(s)`);
      mutate();
    } catch {
      toast.error("Network error");
    }
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Members can use the dashboard and assistant based on their feature permissions.
        Admins have full access to everything. Tap a user to edit.
      </p>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Users</p>
          {users && (
            <Badge variant="secondary" className="ml-auto text-xs">{users.length}</Badge>
          )}
        </SettingsRow>

        {users?.map((u) => (
          <UserCard
            key={u.id}
            u={u}
            isSelf={u.id === user?.userId}
            isLastAdmin={u.role === "admin" && adminCount <= 1}
            onMutate={() => mutate()}
          />
        ))}

        {showForm ? (
          <SettingsRow className="flex-col !items-stretch gap-3">
            <form onSubmit={handleCreate} className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="new-user" className="text-xs text-muted-foreground">Username</Label>
                  <Input
                    id="new-user"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="username"
                    className="h-8 text-sm"
                    autoFocus
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-pass" className="text-xs text-muted-foreground">Password</Label>
                  <Input
                    id="new-pass"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="min 8 characters"
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Label className="text-xs text-muted-foreground">Admin</Label>
                <Switch
                  checked={newRole === "admin"}
                  onCheckedChange={(checked) => {
                    setNewRole(checked ? "admin" : "member");
                    if (!checked) setNewPermissions(getDefaultPermissions());
                  }}
                />
              </div>

              {newRole === "member" && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                    Feature Access
                  </p>
                  <PermissionsGrid
                    permissions={newPermissions}
                    onChange={setNewPermissions}
                  />
                </div>
              )}

              <div className="flex items-center gap-3">
                <div className="flex-1" />
                <Button variant="ghost" size="sm" type="button" className="h-7 text-xs" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" className="h-7 text-xs px-4" disabled={creating || !newUsername || !newPassword}>
                  {creating ? "Creating..." : "Create"}
                </Button>
              </div>
            </form>
          </SettingsRow>
        ) : (
          <SettingsRow className="bg-muted/30 py-3">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs gap-1.5"
              onClick={() => setShowForm(true)}
            >
              <HugeiconsIcon icon={Add01Icon} size={14} />
              Add User
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>

      {memberUsers.length > 1 && (
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Bulk Permissions
            </p>
          </SettingsRow>
          <SettingsRow className="flex-col !items-stretch gap-3">
            <p className="text-xs text-muted-foreground">
              Apply the same permissions to all {memberUsers.length} members at once.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleBulkPermissions(getDefaultPermissions())}
              >
                Grant All
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  const none: UserPermissions = {};
                  FEATURE_PERMISSIONS.forEach((k) => { (none as Record<string, boolean>)[k] = false; });
                  handleBulkPermissions(none);
                }}
              >
                Revoke All
              </Button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}
    </div>
  );
}
