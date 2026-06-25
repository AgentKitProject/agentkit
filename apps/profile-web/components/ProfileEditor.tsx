"use client";

import { Button, Input, Textarea } from "@agentkitforge/ui";
import { useEffect, useMemo, useState } from "react";
import type { EditableProfileInput, PrivateProfile, ProfileError } from "@/lib/profile/types";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; profile: PrivateProfile }
  | { status: "error"; message: string };

const emptyForm: EditableProfileInput = {
  displayName: "",
  handle: "",
  avatarInitials: "",
  bio: "",
  websiteUrl: "",
};

export function ProfileEditor() {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [form, setForm] = useState<EditableProfileInput>(emptyForm);
  const [errors, setErrors] = useState<ProfileError[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let active = true;

    async function loadProfile() {
      try {
        const response = await fetch("/api/profile/me", {
          cache: "no-store",
          credentials: "include",
        });

        if (!response.ok) {
          throw new Error("Profile could not be loaded.");
        }

        const profile = (await response.json()) as PrivateProfile;

        if (active) {
          setLoadState({ status: "loaded", profile });
          setForm({
            displayName: profile.displayName,
            handle: profile.handle,
            avatarInitials: profile.avatarInitials,
            bio: profile.bio,
            websiteUrl: profile.websiteUrl,
          });
        }
      } catch (error) {
        if (active) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : "Profile could not be loaded.",
          });
        }
      }
    }

    loadProfile();

    return () => {
      active = false;
    };
  }, []);

  const fieldErrors = useMemo(() => {
    return errors.reduce<Record<string, string>>((result, error) => {
      if (error.field) {
        result[error.field] = error.message;
      }

      return result;
    }, {});
  }, [errors]);

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveState("saving");
    setErrors([]);

    try {
      const response = await fetch("/api/profile/me", {
        method: "PUT",
        cache: "no-store",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const body = await response.json();

      if (!response.ok) {
        setErrors(Array.isArray(body.errors) ? body.errors : [{ message: body.error ?? "Profile could not be saved." }]);
        setSaveState("error");
        return;
      }

      setLoadState({ status: "loaded", profile: body as PrivateProfile });
      setSaveState("saved");
    } catch {
      setErrors([{ message: "Profile could not be saved." }]);
      setSaveState("error");
    }
  }

  function updateField(field: keyof EditableProfileInput, value: string) {
    setSaveState("idle");
    setForm((current) => ({
      ...current,
      [field]: field === "handle" ? value.toLowerCase() : value,
    }));
  }

  if (loadState.status === "loading") {
    return <p className="text-sm text-[var(--muted)]">Loading profile...</p>;
  }

  if (loadState.status === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {loadState.message}
      </div>
    );
  }

  const { profile } = loadState;

  return (
    <form className="grid gap-6" onSubmit={saveProfile}>
      {!profile.handle ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Set a public handle.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <ReadOnlyField label="Email" value={profile.email} note="Your email is private and will not be shown publicly." />
        <ReadOnlyField label="Role" value={profile.role} />
        <ReadOnlyField label="Verified" value={profile.verified ? "Yes" : "No"} />
      </div>

      <EditableField
        error={fieldErrors.displayName}
        label="Display name"
        name="displayName"
        onChange={(value) => updateField("displayName", value)}
        value={form.displayName}
      />
      <p className="-mt-4 text-sm text-[var(--muted)]">
        This is how your name appears on public kit listings.
      </p>

      <EditableField
        error={fieldErrors.handle}
        label="Handle"
        name="handle"
        onChange={(value) => updateField("handle", value)}
        value={form.handle}
      />

      <EditableField
        error={fieldErrors.avatarInitials}
        label="Avatar initials"
        maxLength={4}
        name="avatarInitials"
        onChange={(value) => updateField("avatarInitials", value)}
        value={form.avatarInitials}
      />

      <Textarea
        label="Bio"
        maxLength={500}
        name="bio"
        onChange={(event) => updateField("bio", event.target.value)}
        value={form.bio}
      />

      <EditableField
        error={fieldErrors.websiteUrl}
        label="Website URL"
        name="websiteUrl"
        onChange={(value) => updateField("websiteUrl", value)}
        placeholder="https://example.com"
        value={form.websiteUrl}
      />

      {errors.filter((error) => !error.field).map((error) => (
        <p key={error.message} className="text-sm text-red-700">
          {error.message}
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saveState === "saving"} disabled={saveState === "saving"}>
          {saveState === "saving" ? "Saving..." : "Save profile"}
        </Button>
        {profile.handle ? (
          <Button variant="secondary" href={`/u/${profile.handle}`}>
            View public profile
          </Button>
        ) : null}
        {saveState === "saved" ? <span className="text-sm font-semibold text-emerald-700">Saved</span> : null}
        {saveState === "error" ? <span className="text-sm font-semibold text-red-700">Could not save</span> : null}
      </div>
    </form>
  );
}

function EditableField({
  error,
  label,
  maxLength,
  name,
  onChange,
  placeholder,
  value,
}: {
  error?: string;
  label: string;
  maxLength?: number;
  name: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div className="grid gap-2">
      <Input
        label={label}
        maxLength={maxLength}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      {error ? <span className="text-sm text-red-700">{error}</span> : null}
    </div>
  );
}

function ReadOnlyField({
  label,
  note,
  value,
}: {
  label: string;
  note?: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-base font-medium text-slate-950">{value}</p>
      {note ? <p className="mt-1 text-sm text-[var(--muted)]">{note}</p> : null}
    </div>
  );
}
