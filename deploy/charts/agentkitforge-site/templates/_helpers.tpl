{{/*
Chart name.
*/}}
{{- define "agentkitforge-site.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name. The LIVE cluster resources are named literally
`agentkitforge-site` (ConfigMap/Deployment/Service/Ingress), so the default base
name is the CHART NAME — NOT the release name — to guarantee ArgoCD ADOPTS the
existing objects rather than recreating them under a release-prefixed name.
`fullnameOverride` is an escape hatch only.
*/}}
{{- define "agentkitforge-site.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "agentkitforge-site.name" . -}}
{{- end -}}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "agentkitforge-site.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitforge-site.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels. The LIVE Deployment/Service use the bare `app: agentkitforge-site`
selector, so we MUST emit exactly that (a Deployment's selector is immutable —
adding more labels would force a recreate, which ArgoCD must not do on adoption).
*/}}
{{- define "agentkitforge-site.selectorLabels" -}}
app: {{ include "agentkitforge-site.fullname" . }}
{{- end }}

{{/*
ConfigMap name carrying the nginx default.conf.
*/}}
{{- define "agentkitforge-site.configmapName" -}}
{{ include "agentkitforge-site.fullname" . }}-conf
{{- end }}
