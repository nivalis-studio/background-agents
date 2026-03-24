"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  MODEL_REASONING_CONFIG,
  isValidReasoningEffort,
  type DiscordBotSettings,
  type DiscordGlobalConfig,
  type EnrichedRepository,
  type ValidModel,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { RadioCard } from "@/components/ui/form-controls";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/discord";
const REPO_SETTINGS_KEY = "/api/integration-settings/discord/repos";

interface GlobalResponse {
  settings: DiscordGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: DiscordBotSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

export function DiscordIntegrationSettings() {
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");
  const { enabledModelOptions } = useEnabledModels();

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">Discord Bot</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Configure Discord slash-command sessions, repository scope, and prompt behavior.
      </p>

      <Section
        title="Connection"
        description="Discord uses control-plane repository access and worker-side thread mappings."
      >
        {availableRepos.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Repository access is available. You can allow all repositories or restrict the Discord
            bot to a selected allowlist.
          </p>
        ) : (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-sm">
            No repositories are currently accessible from the control plane. Repository filtering is
            unavailable until repository access is configured.
          </p>
        )}
      </Section>

      <GlobalSettingsSection
        settings={settings}
        availableRepos={availableRepos}
        enabledModelOptions={enabledModelOptions}
      />

      <Section
        title="Repository Overrides"
        description="Override model selection and Discord runtime behavior for specific repositories."
      >
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          enabledModelOptions={enabledModelOptions}
        />
      </Section>
    </div>
  );
}

function GlobalSettingsSection({
  settings,
  availableRepos,
  enabledModelOptions,
}: {
  settings: DiscordGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(settings?.defaults?.model ?? "");
  const [effort, setEffort] = useState(settings?.defaults?.reasoningEffort ?? "");
  const [enabledRepos, setEnabledRepos] = useState<string[]>(settings?.enabledRepos ?? []);
  const [repoScopeMode, setRepoScopeMode] = useState<"all" | "selected">(
    settings?.enabledRepos == null ? "all" : "selected"
  );
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    settings?.defaults?.allowUserPreferenceOverride ?? true
  );
  const [createThreadsOnNewSession, setCreateThreadsOnNewSession] = useState(
    settings?.defaults?.createThreadsOnNewSession ?? true
  );
  const [sessionInstructions, setSessionInstructions] = useState(
    settings?.defaults?.sessionInstructions ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setModel(settings.defaults?.model ?? "");
        setEffort(settings.defaults?.reasoningEffort ?? "");
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos === undefined ? "all" : "selected");
        setAllowUserPreferenceOverride(settings.defaults?.allowUserPreferenceOverride ?? true);
        setCreateThreadsOnNewSession(settings.defaults?.createThreadsOnNewSession ?? true);
        setSessionInstructions(settings.defaults?.sessionInstructions ?? "");
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;
  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const handleConfirmReset = async () => {
    setSaving(true);
    setError("");

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });
      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setModel("");
        setEffort("");
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setAllowUserPreferenceOverride(true);
        setCreateThreadsOnNewSession(true);
        setSessionInstructions("");
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");

    const defaults: DiscordBotSettings = {
      allowUserPreferenceOverride,
      createThreadsOnNewSession,
    };

    if (model) defaults.model = model;
    if (effort) defaults.reasoningEffort = effort;
    if (sessionInstructions) defaults.sessionInstructions = sessionInstructions;

    const body: DiscordGlobalConfig = { defaults };
    if (repoScopeMode === "selected") {
      body.enabledRepos = enabledRepos;
    }

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        toast.success("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleRepo = (fullName: string) => {
    const lower = fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(lower) ? prev.filter((r) => r !== lower) : [...prev, lower]
    );
    setDirty(true);
    setError("");
  };

  return (
    <Section
      title="Defaults & Scope"
      description="Global model, thread behavior, and repository targeting for Discord sessions."
    >
      {error && <Message tone="error" text={error} />}

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default model</span>
          <Select
            value={model}
            onValueChange={(nextModel) => {
              setModel(nextModel);
              if (effort && nextModel && !isValidReasoningEffort(nextModel, effort)) {
                setEffort("");
              }
              setDirty(true);
              setError("");
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Use system default" />
            </SelectTrigger>
            <SelectContent>
              {enabledModelOptions.map((group) => (
                <SelectGroup key={group.category}>
                  <SelectLabel>{group.category}</SelectLabel>
                  {group.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default reasoning effort</span>
          <Select
            value={effort}
            onValueChange={(v) => {
              setEffort(v);
              setDirty(true);
              setError("");
            }}
            disabled={!reasoningConfig}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Use model default" />
            </SelectTrigger>
            <SelectContent>
              {(reasoningConfig?.efforts ?? []).map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2 mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Allow user model preferences</span>
          <Checkbox
            checked={allowUserPreferenceOverride}
            onCheckedChange={(checked) => {
              setAllowUserPreferenceOverride(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Create threads for new sessions</span>
          <Checkbox
            checked={createThreadsOnNewSession}
            onCheckedChange={(checked) => {
              setCreateThreadsOnNewSession(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1">
          Session Instructions
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Custom instructions appended to agent prompts for Discord sessions.
        </p>
        <Textarea
          value={sessionInstructions}
          onChange={(e) => {
            setSessionInstructions(e.target.value);
            setDirty(true);
            setError("");
          }}
          rows={3}
          placeholder="e.g., Prefer concise progress updates and always mention the changed repo area."
          className="resize-y"
        />
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name="discord-repo-scope"
            checked={repoScopeMode === "all"}
            onChange={() => {
              setRepoScopeMode("all");
              setDirty(true);
              setError("");
            }}
            label="All repositories"
            description="Discord slash commands can run against every accessible repository."
          />
          <RadioCard
            name="discord-repo-scope"
            checked={repoScopeMode === "selected"}
            onChange={() => {
              setRepoScopeMode("selected");
              setDirty(true);
              setError("");
            }}
            label="Selected repositories"
            description="Discord sessions run only for repositories in the allowlist."
          />
        </div>

        {repoScopeMode === "selected" && (
          <>
            {availableRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3 border border-border rounded-sm">
                Repository filtering is unavailable because no repositories are accessible.
              </p>
            ) : (
              <div className="border border-border max-h-56 overflow-y-auto rounded-sm">
                {availableRepos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = enabledRepos.includes(fullName);

                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleRepo(repo.fullName)}
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {enabledRepos.length === 0 && availableRepos.length > 0 && (
              <p className="text-xs text-amber-700 mt-1">
                No repositories selected. The Discord integration will ignore all `/inspect`
                requests.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={() => setShowResetDialog(true)} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>
              Reset all Discord settings to defaults? This re-enables user preferences and thread
              creation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
  enabledModelOptions,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const [owner, name] = addingRepo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/discord/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setAddingRepo("");
        toast.success("Override added.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to add override");
      }
    } catch {
      toast.error("Failed to add override");
    }
  };

  return (
    <div>
      {overrides.length > 0 ? (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow
              key={entry.repo}
              entry={entry}
              enabledModelOptions={enabledModelOptions}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to customize Discord behavior per repo.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {availableForOverride.map((repo) => (
              <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
      </div>
    </div>
  );
}

function RepoOverrideRow({
  entry,
  enabledModelOptions,
}: {
  entry: RepoSettingsEntry;
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(entry.settings.model ?? "");
  const [effort, setEffort] = useState(entry.settings.reasoningEffort ?? "");
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    entry.settings.allowUserPreferenceOverride ?? true
  );
  const [createThreadsOnNewSession, setCreateThreadsOnNewSession] = useState(
    entry.settings.createThreadsOnNewSession ?? true
  );
  const [sessionInstructions, setSessionInstructions] = useState(
    entry.settings.sessionInstructions ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const handleSave = async () => {
    setSaving(true);

    const [owner, name] = entry.repo.split("/");
    const settings: DiscordBotSettings = {
      allowUserPreferenceOverride,
      createThreadsOnNewSession,
    };
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;
    if (sessionInstructions) settings.sessionInstructions = sessionInstructions;

    try {
      const res = await fetch(`/api/integration-settings/discord/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setDirty(false);
        toast.success(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save override");
      }
    } catch {
      toast.error("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const [owner, name] = entry.repo.split("/");
    try {
      const res = await fetch(`/api/integration-settings/discord/repos/${owner}/${name}`, {
        method: "DELETE",
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        toast.success(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete override");
      }
    } catch {
      toast.error("Failed to delete override");
    }
  };

  return (
    <div className="grid gap-2 px-4 py-3 border border-border rounded-sm">
      <div className="text-sm font-medium text-foreground">{entry.repo}</div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <Select
          value={model}
          onValueChange={(newModel) => {
            setModel(newModel);
            setDirty(true);
            if (effort && newModel && !isValidReasoningEffort(newModel, effort)) {
              setEffort("");
            }
          }}
        >
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default model" />
          </SelectTrigger>
          <SelectContent>
            {enabledModelOptions.map((group) => (
              <SelectGroup key={group.category}>
                <SelectLabel>{group.category}</SelectLabel>
                {group.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={effort}
          onValueChange={(value) => {
            setEffort(value);
            setDirty(true);
          }}
          disabled={!reasoningConfig}
        >
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default effort" />
          </SelectTrigger>
          <SelectContent>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>User preference override</span>
          <Checkbox
            checked={allowUserPreferenceOverride}
            onCheckedChange={(checked) => {
              setAllowUserPreferenceOverride(!!checked);
              setDirty(true);
            }}
          />
        </label>

        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Create threads</span>
          <Checkbox
            checked={createThreadsOnNewSession}
            onCheckedChange={(checked) => {
              setCreateThreadsOnNewSession(!!checked);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <Textarea
        value={sessionInstructions}
        onChange={(e) => {
          setSessionInstructions(e.target.value);
          setDirty(true);
        }}
        rows={2}
        placeholder="Optional repo-specific instructions"
        className="resize-y"
      />

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}

function Message({ tone, text }: { tone: "error" | "success"; text: string }) {
  const classes =
    tone === "error"
      ? "mb-4 bg-red-50 text-red-700 px-4 py-3 border border-red-200 text-sm rounded-sm"
      : "mb-4 bg-green-50 text-green-700 px-4 py-3 border border-green-200 text-sm rounded-sm";

  return (
    <div className={classes} aria-live="polite">
      {text}
    </div>
  );
}
