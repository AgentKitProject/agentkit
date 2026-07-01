{{/*
Expand the name of the chart.
*/}}
{{- define "agentkit-keycloak.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name (release name, like the app charts).
*/}}
{{- define "agentkit-keycloak.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentkit-keycloak.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkit-keycloak.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — Keycloak
*/}}
{{- define "agentkit-keycloak.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentkit-keycloak.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: keycloak
{{- end }}

{{/*
Chart-managed Secret name (Keycloak admin + DB + client secrets + SMTP).
*/}}
{{- define "agentkit-keycloak.secretName" -}}
{{ include "agentkit-keycloak.fullname" . }}-secret
{{- end }}

{{/*
Effective Secret name — the existing Secret if provided, else chart-managed.
*/}}
{{- define "agentkit-keycloak.effectiveSecretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "agentkit-keycloak.secretName" . }}
{{- end -}}
{{- end }}

{{/*
Realm-import ConfigMap name.
*/}}
{{- define "agentkit-keycloak.realmConfigmapName" -}}
{{ include "agentkit-keycloak.fullname" . }}-realm
{{- end }}

{{/*
---------------------------------------------------------------------------
Secret generation / persistence helpers (mirrors the app charts).

Each "effective<X>" template resolves to, in order:
  1. the explicitly-set value, if provided;
  2. (when secrets.generate is true) the value PERSISTED from a prior install,
     read via `lookup` from the live chart-managed Secret — so `helm upgrade`
     keeps the strong random value minted on the first successful install;
  3. a generated fallback that is DETERMINISTIC within a single render (so the
     Deployment env, the Secret, and the realm-import ConfigMap all agree).
---------------------------------------------------------------------------
*/}}

{{/* Deterministic per-release fallback for a named credential. */}}
{{- define "agentkit-keycloak._seededSecret" -}}
{{- $root := index . 0 -}}
{{- $purpose := index . 1 -}}
{{- printf "%s/%s/%s" $root.Release.Namespace $root.Release.Name $purpose | sha256sum -}}
{{- end }}

{{/* Read a base64 key from a live Secret by name, decoded; "" if missing/dry-run. */}}
{{- define "agentkit-keycloak._liveSecretValue" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $key := index . 2 -}}
{{- $live := (lookup "v1" "Secret" $root.Release.Namespace $name) | default dict -}}
{{- $data := $live.data | default dict -}}
{{- if hasKey $data $key -}}
{{- index $data $key | b64dec -}}
{{- end -}}
{{- end }}

{{/* Effective Keycloak admin password (explicit | persisted | seeded-fallback). */}}
{{- define "agentkit-keycloak.effectiveAdminPassword" -}}
{{- if .Values.admin.password -}}
{{- .Values.admin.password -}}
{{- else if .Values.secrets.generate -}}
{{- $prev := include "agentkit-keycloak._liveSecretValue" (list . (include "agentkit-keycloak.secretName" .) "KC_BOOTSTRAP_ADMIN_PASSWORD") -}}
{{- $prev | default (include "agentkit-keycloak._seededSecret" (list . "admin-password")) -}}
{{- else -}}
{{- required "set admin.password or enable secrets.generate or use an existing secret" .Values.admin.password -}}
{{- end -}}
{{- end }}

{{/* Effective bundled-Postgres password (explicit | persisted | seeded-fallback). */}}
{{- define "agentkit-keycloak.effectiveDbPassword" -}}
{{- if .Values.postgres.password -}}
{{- .Values.postgres.password -}}
{{- else if .Values.secrets.generate -}}
{{- $prev := include "agentkit-keycloak._liveSecretValue" (list . (include "agentkit-keycloak.secretName" .) "KC_DB_PASSWORD") -}}
{{- $prev | default (include "agentkit-keycloak._seededSecret" (list . "db-password")) -}}
{{- else -}}
{{- required "set postgres.password or enable secrets.generate" .Values.postgres.password -}}
{{- end -}}
{{- end }}

{{/*
Effective DB password for the realm/Keycloak DB connection. With bundled
postgres it is the generated/pinned bundled password; with an external DB it is
db.password (required).
*/}}
{{- define "agentkit-keycloak.effectiveKcDbPassword" -}}
{{- if .Values.postgres.enabled -}}
{{- include "agentkit-keycloak.effectiveDbPassword" . -}}
{{- else -}}
{{- required "postgres.enabled=false requires db.password (external Postgres)" .Values.db.password -}}
{{- end -}}
{{- end }}

{{/*
Effective client secret for a given app client. Resolution order:
  1. the client's explicit `secret` value;
  2. (secrets.generate) persisted value from the live Secret, keyed
     CLIENT_SECRET_<CLIENTID uppercased, non-alnum → _>;
  3. deterministic seeded fallback.
The SAME value is emitted into both the realm-import JSON and the chart Secret,
and MUST match each app's OIDC_CLIENT_SECRET.
args: (list $ <clientMap>)
*/}}
{{- define "agentkit-keycloak.effectiveClientSecret" -}}
{{- $root := index . 0 -}}
{{- $client := index . 1 -}}
{{- $key := printf "CLIENT_SECRET_%s" (upper (regexReplaceAll "[^A-Za-z0-9]" $client.clientId "_")) -}}
{{- if $client.secret -}}
{{- $client.secret -}}
{{- else if $root.Values.secrets.generate -}}
{{- $prev := include "agentkit-keycloak._liveSecretValue" (list $root (include "agentkit-keycloak.secretName" $root) $key) -}}
{{- $prev | default (include "agentkit-keycloak._seededSecret" (list $root (printf "client-secret-%s" $client.clientId))) -}}
{{- else -}}
{{- required (printf "set clients entry %q secret or enable secrets.generate" $client.clientId) $client.secret -}}
{{- end -}}
{{- end }}

{{/*
The Secret data key under which a client's secret is stored/looked-up.
args: <clientId>
*/}}
{{- define "agentkit-keycloak.clientSecretKey" -}}
{{- printf "CLIENT_SECRET_%s" (upper (regexReplaceAll "[^A-Za-z0-9]" . "_")) -}}
{{- end }}
