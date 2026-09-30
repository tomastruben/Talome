"use client";

import { useId, useState } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon, Add01Icon, LinkSquare01Icon } from "@/components/icons";
import { CopyButton } from "@/components/ui/copy-button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { RecoveryCodeDialog } from "@/components/trust/recovery-code";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { useUser } from "@/hooks/use-user";
import { SettingsGroup, SettingsRow, relativeTime, settingsFetcher, settingsRequest } from "@/components/settings/settings-primitives";
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

interface InvitationRow {
  id: string;
  email: string;
  role: "admin" | "member";
  permissions: UserPermissions;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: "pending" | "accepted" | "revoked" | "expired";
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return typeof error === "string" ? error : fallback;
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
  onRecoveryCode,
}: {
  u: UserRow;
  isSelf: boolean;
  isLastAdmin: boolean;
  onMutate: () => void;
  onRecoveryCode: (code: string, username: string) => void;
}) {
  const confirm = useConfirm();
  const adminSwitchId = useId();
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
          toast.error(data.error ?? "Couldn't change the username. Try another one.");
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
          toast.error(data.error ?? "Couldn't set the new password. Use at least 8 characters, then try again.");
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
          toast.error(data.error ?? "Couldn't update feature access. Try again.");
          setSaving(false);
          return;
        }
      }

      toast.success(`Saved changes to ${editUsername}`);
      setNewPassword("");
      setExpanded(false);
      onMutate();
    } catch {
      toast.error("Couldn't reach the Talome server. Check that it's running, then try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRoleToggle() {
    const promoting = u.role !== "admin";
    const nextRole = promoting ? "admin" : "member";
    // Promotion widens privilege: destructive tier. Demotion is reversible: soft.
    await confirm({
      tier: promoting ? "destructive" : "soft",
      title: promoting ? `Make ${u.username} an admin?` : `Make ${u.username} a member?`,
      consequence: promoting
        ? `${u.username} gets full access: every app and setting, other people's accounts, approvals and agent access.`
        : `${u.username} keeps their account but only reaches the features you allow.`,
      recovery: promoting
        ? "You can make them a member again at any time."
        : "You can make them an admin again at any time.",
      confirmLabel: promoting ? "Make admin" : "Make member",
      busyLabel: "Updating role…",
      run: () => settingsRequest(`${CORE_URL}/api/users/${u.id}`, { method: "PUT", body: { role: nextRole } }, "Couldn't change the role. Try again."),
      receipt: promoting ? `${u.username} is now an admin` : `${u.username} is now a member`,
    }).then(({ confirmed }) => {
      if (confirmed) onMutate();
    });
  }

  async function handleRegenerateRecoveryCode() {
    let issued: string | null = null;
    const { confirmed } = await confirm({
      tier: "destructive",
      title: `Replace ${u.username}'s recovery code?`,
      consequence: `Their current recovery code stops working right away. You'll see the new code once, to pass on to ${u.username}.`,
      recovery: "Their password doesn't change, so they can still sign in.",
      confirmLabel: "Replace recovery code",
      busyLabel: "Creating a new code…",
      run: async () => {
        const data = await settingsRequest<{ recoveryCode?: string }>(
          `${CORE_URL}/api/users/${u.id}/recovery-code`,
          { method: "POST" },
          "Couldn't create a new recovery code. Try again.",
        );
        if (!data.recoveryCode) throw new Error("The server didn't return a code. Try again.");
        issued = data.recoveryCode;
        return data;
      },
    });
    if (confirmed && issued) onRecoveryCode(issued, u.username);
  }

  async function handleDelete() {
    const { confirmed } = await confirm({
      tier: "destructive",
      title: `Delete ${u.username}'s account?`,
      consequence: `${u.username}'s account and preferences are removed, and they can't sign in again.`,
      recovery: "This can't be undone. Apps and files they used stay on the server.",
      irreversible: true,
      confirmLabel: "Delete account",
      busyLabel: "Deleting account…",
      run: () => settingsRequest(`${CORE_URL}/api/users/${u.id}`, { method: "DELETE" }, "Couldn't delete the account. Try again."),
      receipt: `Deleted ${u.username}'s account`,
    });
    if (confirmed) onMutate();
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
              <Label htmlFor={adminSwitchId} className="text-xs text-muted-foreground">Admin</Label>
              <Switch
                id={adminSwitchId}
                checked={u.role === "admin"}
                disabled={!canChangeRole}
                onCheckedChange={() => void handleRoleToggle()}
              />
            </div>
          </div>

          {!isAdmin && (
            <div className="pt-2">
              <p className="text-sm font-medium text-muted-foreground mb-2">
                Feature access
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
              onClick={() => void handleRegenerateRecoveryCode()}
            >
              New recovery code…
            </Button>

            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-status-critical hover:text-status-critical"
                onClick={() => void handleDelete()}
              >
                Delete…
              </Button>
            )}

            <Button
              size="sm"
              className="h-7 text-xs px-4"
              busy={saving}
              busyLabel="Saving…"
              disabled={!hasChanges || (newPassword.length > 0 && newPassword.length < 8)}
              onClick={handleSave}
            >
              Save
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
  const confirm = useConfirm();
  const newAdminId = useId();
  const inviteAdminId = useId();
  const { data: users, error: usersError, isLoading: usersLoading, mutate } = useSWR<UserRow[]>(
    isAdmin ? `${CORE_URL}/api/users` : null,
    settingsFetcher,
    { revalidateOnFocus: false },
  );
  const { data: invitations, mutate: mutateInvitations } = useSWR<InvitationRow[]>(
    isAdmin ? `${CORE_URL}/api/users/invitations` : null,
    settingsFetcher,
    { revalidateOnFocus: false },
  );
  const [issuedCode, setIssuedCode] = useState<{ code: string; username: string } | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "member">("member");
  const [newPermissions, setNewPermissions] = useState<UserPermissions>(getDefaultPermissions());
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [invitePermissions, setInvitePermissions] = useState<UserPermissions>(getDefaultPermissions());
  const [inviting, setInviting] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteLink, setInviteLink] = useState("");

  if (!isAdmin) return null;

  const adminCount = users?.filter((u) => u.role === "admin").length ?? 0;
  const memberUsers = users?.filter((u) => u.role === "member") ?? [];
  const pendingInvitations = invitations?.filter((invitation) => invitation.status === "pending") ?? [];

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/users/invitations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole,
          permissions: inviteRole === "member" ? invitePermissions : undefined,
        }),
      });
      const data = await res.json() as { token?: string; email?: string; error?: unknown };
      if (!res.ok || !data.token) throw new Error(apiErrorMessage(data.error, "Couldn't create the invitation. Check the email address, then try again."));

      setInviteLink(`${window.location.origin}/invite/${encodeURIComponent(data.token)}`);
      setInviteEmail("");
      setInviteRole("member");
      setInvitePermissions(getDefaultPermissions());
      setShowInviteForm(false);
      await mutateInvitations();
      toast.success(`Invitation ready for ${data.email}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't reach the Talome server. Check that it's running, then try again.");
    } finally {
      setInviting(false);
    }
  }

  async function revokeInvitation(invitation: InvitationRow) {
    const { confirmed } = await confirm({
      tier: "soft",
      title: `Revoke the invitation for ${invitation.email}?`,
      consequence: "The invitation link stops working.",
      recovery: "You can send a new invitation at any time.",
      confirmLabel: "Revoke invitation",
      busyLabel: "Revoking invitation…",
      run: () => settingsRequest(`${CORE_URL}/api/users/invitations/${invitation.id}`, { method: "DELETE" }, "Couldn't revoke the invitation. Try again."),
      receipt: `Revoked the invitation for ${invitation.email}`,
    });
    if (confirmed) await mutateInvitations();
  }

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
        toast.error(data.error ?? "Couldn't create the account. Try another username.");
        return;
      }
      const data = await res.json() as { recoveryCode?: string };
      if (data.recoveryCode) setIssuedCode({ code: data.recoveryCode, username: newUsername });
      toast.success(`Created ${newUsername}'s account`);
      setNewUsername("");
      setNewPassword("");
      setNewRole("member");
      setNewPermissions(getDefaultPermissions());
      setShowForm(false);
      mutate();
    } catch {
      toast.error("Couldn't reach the Talome server. Check that it's running, then try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleBulkPermissions(permissions: UserPermissions, widening: boolean) {
    const ids = memberUsers.map((u) => u.id);
    if (ids.length === 0) return;
    const { confirmed } = await confirm({
      tier: widening ? "destructive" : "soft",
      title: widening ? `Give all ${ids.length} members every feature?` : `Turn off every feature for all ${ids.length} members?`,
      consequence: widening
        ? "Every member can use every feature, including ones you turned off for them."
        : "Members keep their accounts but can't use any feature until you turn some back on.",
      recovery: "Each member's previous feature list isn't kept. You can adjust members one by one afterwards.",
      confirmLabel: widening ? "Grant all features" : "Revoke all features",
    });
    if (!confirmed) return;

    try {
      const res = await fetch(`${CORE_URL}/api/users/bulk-permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userIds: ids, permissions }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? "Couldn't update feature access. Try again.");
        return;
      }
      const data = await res.json() as { updated: number };
      toast.success(`Updated permissions for ${data.updated} user(s)`);
      mutate();
    } catch {
      toast.error("Couldn't reach the Talome server. Check that it's running, then try again.");
    }
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Invite family without sharing a password. Each person chooses their own credentials,
        then gets access based on the permissions you select.
      </p>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-sm font-medium text-foreground">Family invitations</p>
          {pendingInvitations.length > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">{pendingInvitations.length} pending</Badge>
          )}
        </SettingsRow>

        {inviteLink && (
          <SettingsRow className="flex-col !items-stretch gap-3 bg-primary/[0.04]">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={LinkSquare01Icon} size={15} className="text-muted-foreground" />
              <p className="text-sm font-medium">Invitation link ready</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Send this private link to the invited person. It works once and expires after seven days.
            </p>
            <div className="flex items-start gap-2">
              <Input readOnly value={inviteLink} aria-label="Invitation link" className="h-8 text-xs font-mono" onFocus={(event) => event.currentTarget.select()} />
              <CopyButton value={inviteLink} label="Copy invitation link" text="Copy link" size="sm" variant="default" className="h-8 shrink-0" />
            </div>
          </SettingsRow>
        )}

        {pendingInvitations.map((invitation) => (
          <SettingsRow key={invitation.id} className="gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{invitation.email}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {invitation.role === "admin" ? "Admin" : "Family member"} · expires {new Date(invitation.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive/70" onClick={() => void revokeInvitation(invitation)}>
              Revoke
            </Button>
          </SettingsRow>
        ))}

        {showInviteForm ? (
          <SettingsRow className="flex-col !items-stretch gap-3">
            <form onSubmit={handleInvite} className="grid gap-3">
              <div className="space-y-1">
                <Label htmlFor="invite-email" className="text-xs text-muted-foreground">Email</Label>
                <Input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="family@example.com" className="h-8 text-sm" autoFocus />
              </div>
              <div className="flex items-center gap-3">
                <Label htmlFor={inviteAdminId} className="text-xs text-muted-foreground">Admin access</Label>
                <Switch id={inviteAdminId} checked={inviteRole === "admin"} onCheckedChange={(checked) => setInviteRole(checked ? "admin" : "member")} />
              </div>
              {inviteRole === "member" && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">Feature access</p>
                  <PermissionsGrid permissions={invitePermissions} onChange={setInvitePermissions} />
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" type="button" className="h-7 text-xs" onClick={() => setShowInviteForm(false)}>Cancel</Button>
                <Button size="sm" type="submit" className="h-7 text-xs px-4" busy={inviting} busyLabel="Creating invitation…" disabled={!inviteEmail.trim()}>
                  Create invitation
                </Button>
              </div>
            </form>
          </SettingsRow>
        ) : (
          <SettingsRow className="bg-muted/30 py-3">
            <Button variant="ghost" size="sm" className="text-xs gap-1.5" onClick={() => setShowInviteForm(true)}>
              <HugeiconsIcon icon={Add01Icon} size={14} />
              Invite family
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-sm font-medium text-foreground">Users</p>
          {users && (
            <Badge variant="secondary" className="ml-auto text-xs">{users.length}</Badge>
          )}
        </SettingsRow>

        {usersError && !users ? (
          <SettingsRow>
            <ErrorState
              className="w-full border-0 p-6"
              title="Couldn't load accounts"
              description={usersError instanceof Error ? usersError.message : "Check that the Talome server is reachable, then retry."}
              onRetry={() => void mutate()}
            />
          </SettingsRow>
        ) : null}
        {usersLoading && !users ? (
          <SettingsRow>
            <Skeleton className="h-10 w-full" />
          </SettingsRow>
        ) : null}
        {users?.map((u) => (
          <UserCard
            key={u.id}
            u={u}
            isSelf={u.id === user?.userId}
            isLastAdmin={u.role === "admin" && adminCount <= 1}
            onMutate={() => mutate()}
            onRecoveryCode={(code, username) => setIssuedCode({ code, username })}
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
                    placeholder="At least 8 characters"
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Label htmlFor={newAdminId} className="text-xs text-muted-foreground">Admin</Label>
                <Switch
                  id={newAdminId}
                  checked={newRole === "admin"}
                  onCheckedChange={(checked) => {
                    setNewRole(checked ? "admin" : "member");
                    if (!checked) setNewPermissions(getDefaultPermissions());
                  }}
                />
              </div>

              {newRole === "member" && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Feature access
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
                <Button size="sm" type="submit" className="h-7 text-xs px-4" busy={creating} busyLabel="Creating account…" disabled={!newUsername || newPassword.length < 8}>
                  Create account
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
              Create account manually
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>

      <RecoveryCodeDialog
        code={issuedCode?.code ?? null}
        username={issuedCode?.username}
        onDone={() => setIssuedCode(null)}
      />

      {memberUsers.length > 1 && (
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <p className="text-sm font-medium text-foreground">
              Bulk permissions
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
                onClick={() => void handleBulkPermissions(getDefaultPermissions(), true)}
              >
                Grant all…
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  const none: UserPermissions = {};
                  FEATURE_PERMISSIONS.forEach((k) => { (none as Record<string, boolean>)[k] = false; });
                  void handleBulkPermissions(none, false);
                }}
              >
                Revoke all…
              </Button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}
    </div>
  );
}
