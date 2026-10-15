"use client"

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"

export type SecretFieldHandle = {
  /** Reads the entered value once and clears the field. The caller must not keep it. */
  take: () => string
  clear: () => void
  focus: () => void
}

/**
 * A private, host-owned input for one key. The value never enters React state,
 * props, telemetry or the transcript: the parent takes it once to send it to
 * Den and the field clears. It is shown only while the person is typing and
 * asks to see it; leaving the field hides it again.
 */
export function SecretField({ id, label, labelHidden = false, error, disabled, onSubmit, onValueChange, handleRef, autoFocus = false }: {
  id: string
  label: string
  /** The surrounding title already names the key; keep the label for assistive tech only. */
  labelHidden?: boolean
  error?: string | null
  disabled?: boolean
  onSubmit: () => void
  /** Whether the field holds anything; the value itself is never passed. */
  onValueChange?: (hasValue: boolean) => void
  handleRef?: Ref<SecretFieldHandle>
  autoFocus?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const [hasValue, setHasValue] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const clear = () => {
    if (input.current) input.current.value = ""
    setHasValue(false)
    setRevealed(false)
    onValueChange?.(false)
  }
  useImperativeHandle(handleRef, () => ({
    take: () => {
      const value = input.current?.value ?? ""
      clear()
      return value
    },
    clear,
    focus: () => input.current?.focus(),
  }))
  // Unmounting never leaves a value in a detached input.
  useEffect(() => () => { if (input.current) input.current.value = "" }, [])
  useEffect(() => { if (disabled) setRevealed(false) }, [disabled])

  return (
    <Field data-invalid={error ? true : undefined} data-disabled={disabled ? true : undefined}
      data-secret-field="true" data-private="true" data-sentry-mask="true" data-ph-no-capture="true" className="ph-no-capture">
      <FieldLabel htmlFor={id} className={labelHidden ? "sr-only" : undefined}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          ref={input}
          id={id}
          type={revealed ? "text" : "password"}
          name={`${id}-private`}
          // Not a sign-in password: no autofill, saving or suggestions.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          data-private="true"
          data-ph-no-capture="true"
          maxLength={8192}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            const next = event.currentTarget.value.length > 0
            setHasValue(next)
            onValueChange?.(next)
            if (!next) setRevealed(false)
          }}
          onBlur={(event) => { if (event.relatedTarget !== toggle.current) setRevealed(false) }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); onSubmit() }
            if (event.key === "Escape" && revealed) { event.preventDefault(); setRevealed(false) }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            ref={toggle}
            size="icon-xs"
            aria-label={revealed ? "Hide key" : "Show key while typing"}
            aria-pressed={revealed}
            aria-controls={id}
            disabled={disabled || !hasValue}
            // Keep focus in the field so the reveal never outlives typing.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { setRevealed(value => !value); input.current?.focus() }}
            onBlur={(event) => { if (event.relatedTarget !== input.current) setRevealed(false) }}
          >
            {revealed ? <EyeOff aria-hidden="true" strokeWidth={1.5} /> : <Eye aria-hidden="true" strokeWidth={1.5} />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  )
}
