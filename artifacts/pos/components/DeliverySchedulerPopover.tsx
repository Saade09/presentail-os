import React, { useState, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { DeliveryCity, DeliverySlot } from '@/types';
import { useColors } from '@/hooks/useColors';

const TEAL = '#0D9488';
const AMBER = '#F59E0B';
const SLATE_MUTED = '#94a3b8';
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const SHORT_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type DateStatus = 'past' | 'unavailable' | 'low-capacity' | 'available' | 'today' | 'selected';

interface Props {
  visible: boolean;
  onClose: () => void;
  onConfirm: (date: string, slot: string) => void;
  city: DeliveryCity | undefined;
  initialDate?: string;
  initialSlot?: string;
}

function getDateStatus(
  date: Date,
  today: Date,
  selectedDate: Date | null,
  city: DeliveryCity | undefined,
): DateStatus {
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (dateOnly < todayOnly) return 'past';

  if (selectedDate) {
    const selOnly = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    if (dateOnly.getTime() === selOnly.getTime()) return 'selected';
  }

  if (dateOnly.getTime() === todayOnly.getTime()) return 'today';

  if (!city) return 'available';

  const dow = date.getDay();
  const slotsForDay = city.deliverySlots.filter(s => s.enabled && s.dayOfWeek === dow);

  if (slotsForDay.length === 0) return 'unavailable';

  const totalCapacity = slotsForDay.reduce((sum, s) => sum + s.capacity, 0);
  const hasLowSlot = slotsForDay.some(s => s.capacity <= 2);
  if (hasLowSlot || totalCapacity <= 5) return 'low-capacity';

  return 'available';
}

function isTappable(status: DateStatus): boolean {
  return status !== 'past' && status !== 'unavailable';
}

function formatSummary(date: Date | null, slot: string): string {
  if (!date) return '';
  const d = date.getDate();
  const m = SHORT_MONTH_NAMES[date.getMonth()];
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  return `${day}, ${d} ${m}${slot ? ` · ${slot}` : ''}`;
}

function formatFullDate(date: Date): string {
  const day = DAY_NAMES[date.getDay()];
  const d = date.getDate();
  const m = MONTH_NAMES[date.getMonth()];
  return `${day}, ${d} ${m}`;
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoDate(iso: string): Date | null {
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0]!, 10);
  const m = parseInt(parts[1]!, 10) - 1;
  const d = parseInt(parts[2]!, 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return new Date(y, m, d);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return d;
}

function findNextAvailable(from: Date, city: DeliveryCity | undefined): Date | null {
  if (!city) return addDays(from, 1);
  for (let i = 1; i <= 30; i++) {
    const d = addDays(from, i);
    const dow = d.getDay();
    const hasSlots = city.deliverySlots.some(s => s.enabled && s.dayOfWeek === dow);
    if (hasSlots) return d;
  }
  return null;
}

export function DeliverySchedulerPopover({
  visible,
  onClose,
  onConfirm,
  city,
  initialDate,
  initialSlot,
}: Props) {
  const colors = useColors();
  const today = useMemo(() => new Date(), []);

  const [viewYear, setViewYear] = useState(() => today.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date | null>(() => {
    if (initialDate) return parseIsoDate(initialDate);
    return null;
  });
  const [selectedSlot, setSelectedSlot] = useState<string>(initialSlot ?? '');

  // Build calendar grid
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const startOffset = firstDay.getDay(); // 0=Sun
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevDaysCount = new Date(viewYear, viewMonth, 0).getDate();

    const cells: Array<{ date: Date; isCurrentMonth: boolean }> = [];

    // Prev month overflow
    for (let i = startOffset - 1; i >= 0; i--) {
      cells.push({ date: new Date(viewYear, viewMonth - 1, prevDaysCount - i), isCurrentMonth: false });
    }
    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(viewYear, viewMonth, d), isCurrentMonth: true });
    }
    // Next month overflow (fill to 6 rows)
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      cells.push({ date: new Date(viewYear, viewMonth + 1, d), isCurrentMonth: false });
    }
    return cells;
  }, [viewYear, viewMonth]);

  // Slots for selected date
  const slotsForDay = useMemo(() => {
    if (!selectedDate || !city) return [] as DeliverySlot[];
    const dow = selectedDate.getDay();
    return city.deliverySlots.filter(s => s.enabled && s.dayOfWeek === dow);
  }, [selectedDate, city]);

  const handleSelectDate = useCallback((date: Date) => {
    setSelectedDate(date);
    setSelectedSlot('');
  }, []);

  const handleQuickToday = useCallback(() => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    handleSelectDate(today);
  }, [today, handleSelectDate]);

  const handleQuickTomorrow = useCallback(() => {
    const tomorrow = addDays(today, 1);
    setViewYear(tomorrow.getFullYear());
    setViewMonth(tomorrow.getMonth());
    handleSelectDate(tomorrow);
  }, [today, handleSelectDate]);

  const handleQuickNextAvailable = useCallback(() => {
    const next = findNextAvailable(today, city);
    if (next) {
      setViewYear(next.getFullYear());
      setViewMonth(next.getMonth());
      handleSelectDate(next);
    }
  }, [today, city, handleSelectDate]);

  const prevMonth = useCallback(() => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(y => y - 1);
    } else {
      setViewMonth(m => m - 1);
    }
  }, [viewMonth]);

  const nextMonth = useCallback(() => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(y => y + 1);
    } else {
      setViewMonth(m => m + 1);
    }
  }, [viewMonth]);

  const canConfirm = selectedDate !== null && selectedSlot !== '';

  const handleConfirm = useCallback(() => {
    if (!selectedDate || !selectedSlot) return;
    onConfirm(toIsoDate(selectedDate), selectedSlot);
  }, [selectedDate, selectedSlot, onConfirm]);

  const screenHeight = Dimensions.get('window').height;


  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={onClose}
        accessibilityLabel="Close delivery scheduler"
        accessibilityRole="button"
      >
        <View style={styles.backdropInner} />
      </TouchableOpacity>

      <View style={styles.centered} pointerEvents="box-none">
        <View style={[styles.card, { maxHeight: screenHeight * 0.85, backgroundColor: '#fff' }]}>
          {/* Two-column layout */}
          <View style={styles.columns}>

            {/* ── LEFT: Calendar ── */}
            <View style={styles.leftCol}>
              {/* Quick chips */}
              <View style={styles.quickRow}>
                <TouchableOpacity
                  style={[styles.quickChip, { borderColor: TEAL }]}
                  onPress={handleQuickToday}
                  accessibilityLabel="Select today"
                  accessibilityRole="button"
                >
                  <Text style={[styles.quickChipText, { color: TEAL }]}>Today</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quickChip, { borderColor: TEAL }]}
                  onPress={handleQuickTomorrow}
                  accessibilityLabel="Select tomorrow"
                  accessibilityRole="button"
                >
                  <Text style={[styles.quickChipText, { color: TEAL }]}>Tomorrow</Text>
                </TouchableOpacity>
                {/* Step 1: expanded label */}
                <TouchableOpacity
                  style={[styles.quickChip, { borderColor: TEAL }]}
                  onPress={handleQuickNextAvailable}
                  accessibilityLabel="Select next available date"
                  accessibilityRole="button"
                >
                  <Text style={[styles.quickChipText, { color: TEAL }]}>Next available</Text>
                </TouchableOpacity>
              </View>

              {/* Month nav */}
              <View style={styles.monthNav}>
                <TouchableOpacity
                  onPress={prevMonth}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Previous month"
                  accessibilityRole="button"
                >
                  <Feather name="chevron-left" size={18} color="#1e293b" />
                </TouchableOpacity>
                <Text style={styles.monthLabel}>
                  {MONTH_NAMES[viewMonth]} {viewYear}
                </Text>
                <TouchableOpacity
                  onPress={nextMonth}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Next month"
                  accessibilityRole="button"
                >
                  <Feather name="chevron-right" size={18} color="#1e293b" />
                </TouchableOpacity>
              </View>

              {/* Weekday headers */}
              <View style={styles.weekdayRow}>
                {WEEKDAY_LABELS.map(wd => (
                  <Text key={wd} style={styles.weekdayLabel}>{wd}</Text>
                ))}
              </View>

              {/* Date grid */}
              <View style={styles.dateGrid}>
                {calendarDays.map((cell, idx) => {
                  if (!cell.isCurrentMonth) {
                    return (
                      <View key={idx} style={styles.dateCell}>
                        <Text style={styles.dateCellTextOverflow}>{cell.date.getDate()}</Text>
                      </View>
                    );
                  }

                  const status = getDateStatus(cell.date, today, selectedDate, city);
                  const tappable = isTappable(status);
                  const isSelected = status === 'selected';
                  const isToday = status === 'today';
                  const isLow = status === 'low-capacity';
                  const isPastOrUnavail = status === 'past' || status === 'unavailable';

                  return (
                    <TouchableOpacity
                      key={idx}
                      style={[
                        styles.dateCell,
                        isSelected && { backgroundColor: TEAL, borderRadius: 20 },
                        isToday && !isSelected && { borderWidth: 1.5, borderColor: TEAL, borderRadius: 20 },
                      ]}
                      onPress={() => tappable && handleSelectDate(cell.date)}
                      disabled={!tappable}
                      accessibilityLabel={`${cell.date.getDate()} ${MONTH_NAMES[cell.date.getMonth()]}, ${status}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected, disabled: !tappable }}
                    >
                      <Text style={[
                        styles.dateCellText,
                        isSelected && { color: '#fff', fontFamily: 'Inter_700Bold' },
                        isToday && !isSelected && { color: TEAL, fontFamily: 'Inter_700Bold' },
                        isPastOrUnavail && { color: SLATE_MUTED },
                      ]}>
                        {cell.date.getDate()}
                      </Text>
                      {isLow && !isSelected && (
                        <View style={[styles.dotIndicator, { backgroundColor: AMBER }]} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Step 3: Availability legend — 3-dot horizontal row in left column */}
              <View style={styles.legendRow}>
                <View style={[styles.legendDot, { backgroundColor: TEAL }]} />
                <Text style={styles.legendText}>Available</Text>
                <View style={[styles.legendDot, { backgroundColor: AMBER, marginLeft: 8 }]} />
                <Text style={styles.legendText}>Low capacity</Text>
                <View style={[styles.legendDot, { backgroundColor: SLATE_MUTED, marginLeft: 8 }]} />
                <Text style={styles.legendText}>Unavailable</Text>
              </View>
            </View>

            {/* ── RIGHT: Time slots ── */}
            <View style={[styles.rightCol, { borderLeftColor: '#e2e8f0' }]}>
              <Text style={styles.rightHeading}>
                {selectedDate ? formatFullDate(selectedDate) : 'Select a date'}
              </Text>

              {/* Step 5: "Choose an available time" sub-heading */}
              {selectedDate !== null && slotsForDay.length > 0 && (
                <Text style={styles.rightSubheading}>Choose an available time</Text>
              )}

              {selectedDate && slotsForDay.length === 0 && (
                <Text style={styles.noSlotsText}>No slots available this day.</Text>
              )}

              {/* Step 4: 2-column grid — flexWrap so odd counts don't stretch */}
              {selectedDate && slotsForDay.length > 0 && (
                <ScrollView showsVerticalScrollIndicator={false} style={styles.slotsGrid}>
                  <View style={styles.slotGridInner}>
                    {slotsForDay.map(slot => {
                      const active = selectedSlot === slot.label;
                      return (
                        <TouchableOpacity
                          key={slot.id}
                          style={[
                            styles.slotChip,
                            active
                              ? { backgroundColor: TEAL, borderColor: TEAL }
                              : { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
                          ]}
                          onPress={() => setSelectedSlot(slot.label)}
                          accessibilityLabel={`Time slot: ${slot.label}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                        >
                          <Text style={[styles.slotChipText, { color: active ? '#fff' : '#1e293b' }]}>
                            {slot.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                    {/* Placeholder keeps odd-count last row from stretching to full width */}
                    {slotsForDay.length % 2 !== 0 && (
                      <View style={[styles.slotChip, { backgroundColor: 'transparent', borderColor: 'transparent' }]} />
                    )}
                  </View>
                </ScrollView>
              )}

              {/* Step 6: Horizontal footer */}
              <View style={styles.footer}>
                <Text
                  style={[styles.footerSummary, { opacity: canConfirm ? 1 : 0 }]}
                  numberOfLines={1}
                >
                  {canConfirm ? formatSummary(selectedDate, selectedSlot) : ' '}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.confirmBtn,
                    { backgroundColor: canConfirm ? TEAL : '#cbd5e1' },
                  ]}
                  onPress={handleConfirm}
                  disabled={!canConfirm}
                  accessibilityLabel="Confirm delivery"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canConfirm }}
                >
                  <Text style={styles.confirmBtnText}>Confirm delivery</Text>
                </TouchableOpacity>
              </View>
            </View>

          </View>
        </View>
      </View>
    </Modal>
  );
}

// Step 2: CELL_SIZE increased to 40
const CELL_SIZE = 40;

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdropInner: {
    flex: 1,
  },
  centered: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 700,
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  columns: {
    flexDirection: 'row',
  },
  leftCol: {
    flex: 1,
    padding: 16,
    gap: 10,
  },
  rightCol: {
    width: 220,
    borderLeftWidth: 1,
    padding: 16,
    gap: 8,
    flexDirection: 'column',
  },
  // Quick chips
  quickRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  quickChip: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  quickChipText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
  },
  // Month nav
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  monthLabel: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    color: '#1e293b',
    textAlign: 'center',
    flex: 1,
  },
  // Weekday row
  weekdayRow: {
    flexDirection: 'row',
  },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    color: '#94a3b8',
  },
  // Date grid — Step 2: keep aspectRatio:1 so cells are naturally square (wider = taller)
  dateGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dateCell: {
    width: `${100 / 7}%` as any,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  // Step 2: font size bumped to 13
  dateCellText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: '#1e293b',
  },
  dateCellTextOverflow: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: '#cbd5e1',
  },
  dotIndicator: {
    position: 'absolute',
    bottom: 2,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  // Step 3: legend moved to left column — 3 dots
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    color: '#64748b',
  },
  // Right column
  rightHeading: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
    color: '#1e293b',
  },
  // Step 5: sub-heading
  rightSubheading: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: '#94a3b8',
    marginBottom: 2,
  },
  noSlotsText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: '#94a3b8',
    marginTop: 4,
  },
  // Step 4: 2-column grid styles — width:'48%' keeps odd last chip at half-width
  slotsGrid: {
    maxHeight: 220,
  },
  slotGridInner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  slotChip: {
    width: '48%' as any,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  slotChipText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'center',
  },
  // Step 6: horizontal footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    paddingTop: 8,
  },
  footerSummary: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: '#1e293b',
    textAlign: 'left',
  },
  confirmBtn: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    minWidth: 140,
  },
  confirmBtnText: {
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Inter_700Bold',
  },
});
