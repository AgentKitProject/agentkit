"use client";

import * as React from "react";

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  function Label({ className, children, ...rest }, ref) {
    return (
      <label
        {...rest}
        ref={ref}
        className={["ak-label", className].filter(Boolean).join(" ")}
      >
        {children}
      </label>
    );
  },
);

type FieldWrapProps = {
  label?: React.ReactNode;
  /** Wires label `htmlFor` <-> control `id`. */
  id?: string;
  className?: string;
  children: React.ReactNode;
};

/** Vertical label + control stack. */
export function Field({ label, id, className, children }: FieldWrapProps) {
  return (
    <div className={["ak-field", className].filter(Boolean).join(" ")}>
      {label ? <Label htmlFor={id}>{label}</Label> : null}
      {children}
    </div>
  );
}

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: React.ReactNode;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ label, id, className, ...rest }, ref) {
    const control = (
      <input
        {...rest}
        id={id}
        ref={ref}
        className={["ak-input", label ? "" : className]
          .filter(Boolean)
          .join(" ")}
      />
    );
    if (!label) return control;
    return (
      <Field label={label} id={id} className={className}>
        {control}
      </Field>
    );
  },
);

export type TextareaProps =
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    label?: React.ReactNode;
  };

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ label, id, className, ...rest }, ref) {
    const control = (
      <textarea
        {...rest}
        id={id}
        ref={ref}
        className={["ak-textarea", label ? "" : className]
          .filter(Boolean)
          .join(" ")}
      />
    );
    if (!label) return control;
    return (
      <Field label={label} id={id} className={className}>
        {control}
      </Field>
    );
  },
);

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: React.ReactNode;
};

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ label, id, className, children, ...rest }, ref) {
    const control = (
      <select
        {...rest}
        id={id}
        ref={ref}
        className={["ak-select", label ? "" : className]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </select>
    );
    if (!label) return control;
    return (
      <Field label={label} id={id} className={className}>
        {control}
      </Field>
    );
  },
);
