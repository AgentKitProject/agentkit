{{/*
Expand the name of the chart.
*/}}
{{- define "agentkitprofile.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "agentkitprofile.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentkitprofile.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitprofile.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — web
*/}}
{{- define "agentkitprofile.selectorLabelsWeb" -}}
app.kubernetes.io/name: {{ include "agentkitprofile.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}

{{/*
Web ConfigMap name
*/}}
{{- define "agentkitprofile.webConfigmapName" -}}
{{ include "agentkitprofile.fullname" . }}-web-config
{{- end }}

{{/*
Web Secret name (chart-managed)
*/}}
{{- define "agentkitprofile.webSecretName" -}}
{{ include "agentkitprofile.fullname" . }}-web-secret
{{- end }}

{{/*
Effective web Secret name — the existing Secret if provided, else chart-managed.
*/}}
{{- define "agentkitprofile.webEffectiveSecretName" -}}
{{- if .Values.web.secrets.existingSecret -}}
{{ .Values.web.secrets.existingSecret }}
{{- else -}}
{{ include "agentkitprofile.webSecretName" . }}
{{- end -}}
{{- end }}

{{/*
In-cluster Postgres host (Service name) for the bundled Postgres. Used when
bundled postgres is enabled and no explicit DATABASE_URL is supplied — the
Deployment + migrate Job compose DATABASE_URL from this host and the secret's
POSTGRES_PASSWORD via env interpolation, so the secret only needs the password.
*/}}
{{- define "agentkitprofile.postgresHost" -}}
{{ include "agentkitprofile.fullname" . }}-postgres
{{- end }}

{{/*
---------------------------------------------------------------------------
Secret generation / persistence helpers.

Each "effective<X>" template resolves to, in order:
  1. the explicitly-set value, if provided;
  2. the value PERSISTED from a prior install, read via `lookup` from the live
     chart-managed Secret — so `helm upgrade` keeps the strong random value that
     was minted on the first successful install; otherwise
  3. a generated fallback that is DETERMINISTIC within a single render.

Why deterministic on first install? Helm evaluates every template
independently, so a bare `randAlphaNum` would mint a DIFFERENT value in each
template that references it. Seeding the fallback from the release identity
makes all templates agree on first render. After that first install, `lookup`
returns the persisted value and (1)/(2) take over — so the live credential is
the one minted at install time and never drifts.
---------------------------------------------------------------------------
*/}}

{{/*
Deterministic per-release fallback for a named credential. Stable across all
templates in one render and across upgrades; only used until the live Secret
exists. args: (list $ "PURPOSE_KEY")
*/}}
{{- define "agentkitprofile._seededSecret" -}}
{{- $root := index . 0 -}}
{{- $purpose := index . 1 -}}
{{- printf "%s/%s/%s" $root.Release.Namespace $root.Release.Name $purpose | sha256sum -}}
{{- end }}

{{/* Read a base64 key from a live Secret by name, decoded; "" if missing/dry-run. */}}
{{- define "agentkitprofile._liveSecretValue" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $key := index . 2 -}}
{{- $live := (lookup "v1" "Secret" $root.Release.Namespace $name) | default dict -}}
{{- $data := $live.data | default dict -}}
{{- if hasKey $data $key -}}
{{- index $data $key | b64dec -}}
{{- end -}}
{{- end }}

{{/*
Effective PROFILE_SERVICE_KEY (explicit | persisted | seeded-fallback).
The shared bearer that callers (Market server) present to the profile-api.
Auto-generated + persisted when left empty (and no existingSecret is set).
*/}}
{{- define "agentkitprofile.effectiveProfileServiceKey" -}}
{{- if .Values.web.secrets.profileServiceKey -}}
{{- .Values.web.secrets.profileServiceKey -}}
{{- else -}}
{{- $prev := include "agentkitprofile._liveSecretValue" (list . (include "agentkitprofile.webSecretName" .) "PROFILE_SERVICE_KEY") -}}
{{- $prev | default (include "agentkitprofile._seededSecret" (list . "profile-service-key")) -}}
{{- end -}}
{{- end }}

{{/*
Effective bundled-Postgres password (explicit | persisted | seeded-fallback).
Used only when bundled postgres is enabled (postgres.enabled). The bundled
Postgres + the web/migrate tiers all read POSTGRES_PASSWORD from the effective
secret; DATABASE_URL is composed from it at runtime. Auto-generated + persisted
when left empty (and no existingSecret is set).
*/}}
{{- define "agentkitprofile.effectivePostgresPassword" -}}
{{- if .Values.postgres.password -}}
{{- .Values.postgres.password -}}
{{- else -}}
{{- $prev := include "agentkitprofile._liveSecretValue" (list . (include "agentkitprofile.webSecretName" .) "POSTGRES_PASSWORD") -}}
{{- $prev | default (include "agentkitprofile._seededSecret" (list . "postgres-password")) -}}
{{- end -}}
{{- end }}

{{/*
Effective web SESSION_SECRET (OIDC): explicit | persisted | seeded-fallback.
Signs the iron-session cookie for the OIDC (self-host) auth path. Only emitted
when authProvider=oidc. Auto-generated + persisted across upgrades when empty.
*/}}
{{- define "agentkitprofile.effectiveSessionSecret" -}}
{{- if .Values.web.secrets.sessionSecret -}}
{{- .Values.web.secrets.sessionSecret -}}
{{- else -}}
{{- $prev := include "agentkitprofile._liveSecretValue" (list . (include "agentkitprofile.webSecretName" .) "SESSION_SECRET") -}}
{{- $prev | default (include "agentkitprofile._seededSecret" (list . "session-secret")) -}}
{{- end -}}
{{- end }}

{{/*
Effective PROFILE_KEY_ENCRYPTION_SECRET (explicit | persisted | seeded-fallback).
AES-256-GCM at-rest key for org shared LLM provider keys (mirrors Market's
MARKET_KEY_ENCRYPTION_SECRET). Auto-generated + persisted when left empty (and no
existingSecret is set). If left unset entirely the app degrades to PLAINTEXT
at-rest storage with a one-time warning — but the chart always mints one so the
default self-host posture is encrypted.
*/}}
{{- define "agentkitprofile.effectiveKeyEncryptionSecret" -}}
{{- if .Values.web.secrets.keyEncryptionSecret -}}
{{- .Values.web.secrets.keyEncryptionSecret -}}
{{- else -}}
{{- $prev := include "agentkitprofile._liveSecretValue" (list . (include "agentkitprofile.webSecretName" .) "PROFILE_KEY_ENCRYPTION_SECRET") -}}
{{- $prev | default (include "agentkitprofile._seededSecret" (list . "profile-key-encryption-secret")) -}}
{{- end -}}
{{- end }}
