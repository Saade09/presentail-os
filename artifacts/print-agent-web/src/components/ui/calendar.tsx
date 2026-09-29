"use client"

import * as React from "react"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react"
import { DayButton, DayPicker, getDefaultClassNames } from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"

type CalendarDayStateLabels = Partial<{
  rangeStart: string
  rangeEnd: string
  inRange: string
  today: string
  unavailable: string
  outsideMonth: string
}>

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  formatters,
  components,
  dayStateLabels,
  accessibilityLocale,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>["variant"]
  dayStateLabels?: CalendarDayStateLabels
  accessibilityLocale?: string
}) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        "bg-background group/calendar p-3 [--cell-size:2rem] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent",
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className
      )}
      captionLayout={captionLayout}
      formatters={{
        formatMonthDropdown: (date) =>
          date.toLocaleString("default", { month: "short" }),
        ...formatters,
      }}
      classNames={{
        root: cn("w-fit", defaultClassNames.root),
        months: cn(
          "relative flex flex-col gap-4 md:flex-row",
          defaultClassNames.months
        ),
        month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
        nav: cn(
          "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
          defaultClassNames.nav
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant }),
          "h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
          defaultClassNames.button_previous
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant }),
          "h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
          defaultClassNames.button_next
        ),
        month_caption: cn(
          "flex h-[--cell-size] w-full items-center justify-center px-[--cell-size]",
          defaultClassNames.month_caption
        ),
        dropdowns: cn(
          "flex h-[--cell-size] w-full items-center justify-center gap-1.5 text-sm font-medium",
          defaultClassNames.dropdowns
        ),
        dropdown_root: cn(
          "has-focus:border-ring border-input shadow-xs has-focus:ring-ring/50 has-focus:ring-[3px] relative rounded-md border",
          defaultClassNames.dropdown_root
        ),
        dropdown: cn(
          "bg-popover absolute inset-0 opacity-0",
          defaultClassNames.dropdown
        ),
        caption_label: cn(
          "select-none font-medium",
          captionLayout === "label"
            ? "text-sm"
            : "[&>svg]:text-muted-foreground flex h-8 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:size-3.5",
          defaultClassNames.caption_label
        ),
        table: "w-full border-collapse",
        weekdays: cn("flex h-[--cell-size] items-center", defaultClassNames.weekdays),
        weekday: cn(
          "text-muted-foreground flex-1 select-none rounded-md text-[0.8rem] font-normal",
          defaultClassNames.weekday
        ),
        week: cn("flex w-full", defaultClassNames.week),
        week_number_header: cn(
          "w-[--cell-size] select-none",
          defaultClassNames.week_number_header
        ),
        week_number: cn(
          "text-muted-foreground select-none text-[0.8rem]",
          defaultClassNames.week_number
        ),
        day: cn(
          "group/day relative h-[--cell-size] w-[--cell-size] select-none p-0 text-center [&:first-child[data-selected=true]]:rounded-s-full [&:last-child[data-selected=true]]:rounded-e-full",
          defaultClassNames.day
        ),
        range_start: cn(
          "rounded-s-full bg-teal-100",
          defaultClassNames.range_start
        ),
        range_middle: cn("bg-teal-100 rounded-none", defaultClassNames.range_middle),
        range_end: cn("rounded-e-full bg-teal-100", defaultClassNames.range_end),
        today: cn(
          "[&_button]:ring-1 [&_button]:ring-inset [&_button]:ring-teal-500 data-[selected=true]:[&_button]:ring-0",
          defaultClassNames.today
        ),
        outside: cn(
          "!bg-transparent text-muted-foreground aria-selected:text-muted-foreground [&_button]:!bg-transparent [&_button]:!text-muted-foreground",
          defaultClassNames.outside
        ),
        disabled: cn(
          "text-muted-foreground opacity-50",
          defaultClassNames.disabled
        ),
        hidden: cn("invisible", defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: ({ className, rootRef, ...props }) => {
          return (
            <div
              data-slot="calendar"
              ref={rootRef as React.Ref<HTMLDivElement>}
              className={cn(className)}
              {...props}
            />
          )
        },
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === "left") {
            return (
              <ChevronLeftIcon className={cn("size-4", className)} {...props} />
            )
          }

          if (orientation === "right") {
            return (
              <ChevronRightIcon
                className={cn("size-4", className)}
                {...props}
              />
            )
          }

          return (
            <ChevronDownIcon className={cn("size-4", className)} {...props} />
          )
        },
        DayButton: (dayProps) => (
          <CalendarDayButton
            {...dayProps}
            stateLabelText={dayStateLabels}
            accessibilityLocale={accessibilityLocale}
          />
        ),
        WeekNumber: ({ children, ...props }) => {
          return (
            <td {...props}>
              <div className="flex size-[--cell-size] items-center justify-center text-center">
                {children}
              </div>
            </td>
          )
        },
        ...components,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  stateLabelText,
  accessibilityLocale,
  ...props
}: React.ComponentProps<typeof DayButton> & {
  stateLabelText?: CalendarDayStateLabels
  accessibilityLocale?: string
}) {
  const defaultClassNames = getDefaultClassNames()

  const ref = React.useRef<HTMLButtonElement>(null)
  const isOutside = Boolean(modifiers.outside)
  const isRangeStart = Boolean(modifiers.range_start && !isOutside)
  const isRangeEnd = Boolean(modifiers.range_end && !isOutside)
  const isRangeMiddle = Boolean(modifiers.range_middle && !isOutside)
  const stateLabels = [
    isRangeStart && stateLabelText?.rangeStart,
    isRangeEnd && stateLabelText?.rangeEnd,
    isRangeMiddle && stateLabelText?.inRange,
    modifiers.today && stateLabelText?.today,
    (modifiers.disabled || isOutside) && stateLabelText?.unavailable,
    isOutside && stateLabelText?.outsideMonth,
  ].filter(Boolean)
  const accessibleDate = day.date.toLocaleDateString(accessibilityLocale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })
  const dayTestId = [
    day.date.getFullYear(),
    String(day.date.getMonth() + 1).padStart(2, "0"),
    String(day.date.getDate()).padStart(2, "0"),
  ].join("-")
  const ariaLabel = [
    accessibleDate,
    ...stateLabels,
  ].join(", ")
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      {...props}
      ref={ref}
      disabled={props.disabled || isOutside}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString()}
      data-testid={`button-calendar-day-${dayTestId}`}
      data-selected-single={
        modifiers.selected &&
        !isOutside &&
        !isRangeStart &&
        !isRangeEnd &&
        !isRangeMiddle
      }
      data-range-start={isRangeStart}
      data-range-end={isRangeEnd}
      data-range-middle={isRangeMiddle}
      data-outside={isOutside}
      aria-current={modifiers.today ? "date" : undefined}
      aria-label={ariaLabel}
      className={cn(
        "data-[selected-single=true]:bg-teal-700 data-[selected-single=true]:text-white data-[range-middle=true]:bg-teal-100 data-[range-middle=true]:text-teal-950 data-[range-start=true]:bg-teal-700 data-[range-start=true]:text-white data-[range-end=true]:bg-teal-700 data-[range-end=true]:text-white group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-ring/50 flex size-[--cell-size] min-w-[--cell-size] flex-col gap-1 font-normal leading-none data-[range-end=true]:rounded-full data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-full data-[outside=true]:!bg-transparent data-[outside=true]:!text-muted-foreground data-[outside=true]:opacity-45 group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:ring-[3px] [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        className
      )}
    />
  )
}

export { Calendar, CalendarDayButton }
