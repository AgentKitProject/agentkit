{{/*
Chart name.
*/}}
{{- define "agentkitauto.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name (release name).
*/}}
{{- define "agentkitauto.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentkitauto.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitauto.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — web
*/}}
{{- define "agentkitauto.selectorLabelsWeb" -}}
app.kubernetes.io/name: {{ include "agentkitauto.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}

{{/*
Web ConfigMap name
*/}}
{{- define "agentkitauto.webConfigmapName" -}}
{{ include "agentkitauto.fullname" . }}-web-config
{{- end }}

{{/*
Web Secret name (chart-managed)
*/}}
{{- define "agentkitauto.webSecretName" -}}
{{ include "agentkitauto.fullname" . }}-web-secret
{{- end }}

{{/*
Effective web Secret name — the existing Secret if provided, else chart-managed.
*/}}
{{- define "agentkitauto.webEffectiveSecretName" -}}
{{- if .Values.web.secrets.existingSecret -}}
{{ .Values.web.secrets.existingSecret }}
{{- else -}}
{{ include "agentkitauto.webSecretName" . }}
{{- end -}}
{{- end }}

{{/*
In-cluster Postgres host (the password is read at runtime from the effective
secret; the Deployment composes DATABASE_URL via env interpolation).
*/}}
{{- define "agentkitauto.postgresHost" -}}
{{ include "agentkitauto.fullname" . }}-postgres
{{- end }}

{{/*
Resolve-or-generate a secret value, preserving any value already stored in the
chart-managed Secret across upgrades. Order of precedence:
  1. the explicit value passed in (a configured `.Values.*` field), if non-empty;
  2. the value already present (base64) in the live chart-managed Secret, if any
     (so `helm upgrade` does NOT churn auto-generated secrets);
  3. a freshly generated random value.
Usage: {{ include "agentkitauto.resolveSecret" (dict "ctx" $ "given" .Values.x "key" "FOO" "gen" "rand32") }}
`gen` is one of: rand32 (random base64 — secrets/passwords), hex32 (sha256 hex
— service keys), pw24 (24-char alnum — DB/MinIO passwords).
Returns the PLAINTEXT value (callers b64enc when writing the Secret).
*/}}
{{- define "agentkitauto.resolveSecret" -}}
{{- $ctx := .ctx -}}
{{- $given := .given | default "" -}}
{{- if $given -}}
{{- $given -}}
{{- else -}}
{{- $secretName := include "agentkitauto.webSecretName" $ctx -}}
{{- $existing := (lookup "v1" "Secret" $ctx.Release.Namespace $secretName) -}}
{{- $prior := "" -}}
{{- if $existing -}}
{{- with (get (default (dict) $existing.data) .key) -}}
{{- $prior = (b64dec .) -}}
{{- end -}}
{{- end -}}
{{- if $prior -}}
{{- $prior -}}
{{- else if eq .gen "hex32" -}}
{{- printf "%s%s" (randAlphaNum 32) (now | date "150405.000000") | sha256sum -}}
{{- else if eq .gen "pw24" -}}
{{- randAlphaNum 24 -}}
{{- else -}}
{{- randAlphaNum 40 -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
In-cluster MinIO endpoint.
*/}}
{{- define "agentkitauto.minioEndpoint" -}}
http://{{ include "agentkitauto.fullname" . }}-minio:9000
{{- end }}

{{/*
Web ServiceAccount name. The web pod always runs under this SA so RBAC can grant
it Job-management permissions (the Auto dispatcher creates one Job per run).
*/}}
{{- define "agentkitauto.webServiceAccountName" -}}
{{ include "agentkitauto.fullname" . }}-web
{{- end }}

{{/*
In-cluster web Service URL (used by the Auto worker + sweep to reach the app's
internal endpoints). Honors auto.internalUrl when set.
*/}}
{{- define "agentkitauto.webInternalUrl" -}}
{{- if .Values.auto.internalUrl -}}
{{ .Values.auto.internalUrl }}
{{- else -}}
http://{{ include "agentkitauto.fullname" . }}-web
{{- end -}}
{{- end }}

{{/*
The namespace the Auto dispatcher creates worker Jobs in (auto.namespace or the
release namespace).
*/}}
{{- define "agentkitauto.autoNamespace" -}}
{{- if .Values.auto.namespace -}}
{{ .Values.auto.namespace }}
{{- else -}}
{{ .Release.Namespace }}
{{- end -}}
{{- end }}
