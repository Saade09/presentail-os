type AddressCollectorOrderLabelProps = {
  orderId: string | number | null;
  orderNumber: string | null;
  orderLabel: string;
  standaloneLabel: string;
  unavailableLabel: string;
};

function normalizedOrderNumber(value: string | null): string | null {
  const normalized = value?.trim().replace(/^#+\s*/, "") ?? "";
  return normalized || null;
}

export function AddressCollectorOrderLabel({
  orderId,
  orderNumber,
  orderLabel,
  standaloneLabel,
  unavailableLabel,
}: AddressCollectorOrderLabelProps) {
  if (!orderId) return <>{standaloneLabel}</>;

  const number = normalizedOrderNumber(orderNumber);
  return (
    <>
      {orderLabel} {number ? `#${number}` : unavailableLabel}
    </>
  );
}