{{/*
Chart name.
*/}}
{{- define "agentkitproject-site.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name. Defaults to the CHART NAME (not the release name) so
the cluster objects are named literally `agentkitproject-site`, which keeps
ArgoCD adoption + manual kubectl predictable. `fullnameOverride` is an escape
hatch only.
*/}}
{{- define "agentkitproject-site.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "agentkitproject-site.name" . -}}
{{- end -}}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "agentkitproject-site.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitproject-site.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels (bare `app: <fullname>` — Deployment selector is immutable).
*/}}
{{- define "agentkitproject-site.selectorLabels" -}}
app: {{ include "agentkitproject-site.fullname" . }}
{{- end }}
