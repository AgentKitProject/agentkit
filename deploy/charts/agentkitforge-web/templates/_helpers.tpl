{{/*
Chart name.
*/}}
{{- define "agentkitforge-web.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name (release name).
*/}}
{{- define "agentkitforge-web.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentkitforge-web.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitforge-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — web
*/}}
{{- define "agentkitforge-web.selectorLabelsWeb" -}}
app.kubernetes.io/name: {{ include "agentkitforge-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}

{{/*
Web ConfigMap name
*/}}
{{- define "agentkitforge-web.webConfigmapName" -}}
{{ include "agentkitforge-web.fullname" . }}-web-config
{{- end }}

{{/*
Web Secret name (chart-managed)
*/}}
{{- define "agentkitforge-web.webSecretName" -}}
{{ include "agentkitforge-web.fullname" . }}-web-secret
{{- end }}

{{/*
Effective web Secret name — the existing Secret if provided, else chart-managed.
*/}}
{{- define "agentkitforge-web.webEffectiveSecretName" -}}
{{- if .Values.web.secrets.existingSecret -}}
{{ .Values.web.secrets.existingSecret }}
{{- else -}}
{{ include "agentkitforge-web.webSecretName" . }}
{{- end -}}
{{- end }}

{{/*
In-cluster Postgres DATABASE_URL (used when bundled postgres is enabled and the
secret does not already supply DATABASE_URL). The password is read at runtime
from the effective secret, so we only build the non-secret parts here and let
the Deployment compose the URL via env interpolation.
*/}}
{{- define "agentkitforge-web.postgresHost" -}}
{{ include "agentkitforge-web.fullname" . }}-postgres
{{- end }}

{{/*
Resolve-or-generate a secret value, preserving any value already stored in the
chart-managed Secret across upgrades. Order of precedence:
  1. the explicit value passed in (a configured `.Values.*` field), if non-empty;
  2. the value already present (base64) in the live chart-managed Secret, if any
     (so `helm upgrade` does NOT churn auto-generated secrets);
  3. a freshly generated random value.
Usage: {{ include "agentkitforge-web.resolveSecret" (dict "ctx" $ "given" .Values.x "key" "FOO" "gen" "rand32") }}
`gen` is one of: rand32 (32-byte base64 — secrets/passwords), hex32 (32-byte hex
— service keys), pw24 (24-char alnum — DB/MinIO passwords).
Returns the PLAINTEXT value (callers b64enc when writing the Secret).
*/}}
{{- define "agentkitforge-web.resolveSecret" -}}
{{- $ctx := .ctx -}}
{{- $given := .given | default "" -}}
{{- if $given -}}
{{- $given -}}
{{- else -}}
{{- $secretName := include "agentkitforge-web.webSecretName" $ctx -}}
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
{{- define "agentkitforge-web.minioEndpoint" -}}
http://{{ include "agentkitforge-web.fullname" . }}-minio:9000
{{- end }}
