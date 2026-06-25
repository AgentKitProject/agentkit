{{/*
Expand the name of the chart.
*/}}
{{- define "agentkitgateway.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.

NOTE: this is just the release name. With an ArgoCD app whose Release.Name is
"agentkitgateway", the Deployment and (suffix-less) Service are both named
"agentkitgateway", so the Stripe webhook in agentkitmarket can reach this
service in-cluster at http://agentkitgateway.
*/}}
{{- define "agentkitgateway.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentkitgateway.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitgateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "agentkitgateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentkitgateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gateway
{{- end }}

{{/*
ConfigMap name
*/}}
{{- define "agentkitgateway.configmapName" -}}
{{ include "agentkitgateway.fullname" . }}-config
{{- end }}

{{/*
Secret name (chart-managed)
*/}}
{{- define "agentkitgateway.secretName" -}}
{{ include "agentkitgateway.fullname" . }}-secret
{{- end }}

{{/*
Effective Secret name — the existing Secret if provided, else chart-managed.
*/}}
{{- define "agentkitgateway.effectiveSecretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "agentkitgateway.secretName" . }}
{{- end -}}
{{- end }}
