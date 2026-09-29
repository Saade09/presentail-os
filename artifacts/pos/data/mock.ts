import type { Order, Product, Customer, DeliveryCity, CannedReply, RefundRequest } from '@/types';

export const MOCK_AGENT = { id: 'agent-1', name: 'Sarah Al-Hassan' };

export const DELIVERY_CITIES: DeliveryCity[] = [
  {
    id: 'city-1', numericId: 1, name: 'Dubai', isActive: true, deliveryFee: 25, freeDeliveryThreshold: 300,
    freeDeliveryEnabled: true, expressAvailable: true, expressCutoffTime: '14:00', expressFee: 50,
    deliverySlots: [
      { id: 'ds-1', dayOfWeek: 0, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 20, enabled: true },
      { id: 'ds-2', dayOfWeek: 0, label: '2 PM – 4 PM', startTime: '14:00', endTime: '16:00', capacity: 20, enabled: true },
      { id: 'ds-3', dayOfWeek: 1, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 15, enabled: true },
      { id: 'ds-4', dayOfWeek: 1, label: '2 PM – 4 PM', startTime: '14:00', endTime: '16:00', capacity: 3, enabled: true },
      { id: 'ds-5', dayOfWeek: 1, label: '5 PM – 7 PM', startTime: '17:00', endTime: '19:00', capacity: 10, enabled: true },
      { id: 'ds-6', dayOfWeek: 2, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 15, enabled: true },
      { id: 'ds-7', dayOfWeek: 2, label: '2 PM – 4 PM', startTime: '14:00', endTime: '16:00', capacity: 15, enabled: true },
      { id: 'ds-8', dayOfWeek: 3, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 15, enabled: true },
      { id: 'ds-9', dayOfWeek: 3, label: '2 PM – 4 PM', startTime: '14:00', endTime: '16:00', capacity: 15, enabled: true },
      { id: 'ds-10', dayOfWeek: 4, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 15, enabled: true },
      { id: 'ds-11', dayOfWeek: 4, label: '2 PM – 4 PM', startTime: '14:00', endTime: '16:00', capacity: 15, enabled: true },
      { id: 'ds-12', dayOfWeek: 5, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 10, enabled: true },
      { id: 'ds-13', dayOfWeek: 5, label: '2 PM – 4 PM', startTime: '14:00', endTime: '16:00', capacity: 2, enabled: true },
      // No delivery on Saturday (6)
    ],
  },
  {
    id: 'city-2', numericId: 2, name: 'Abu Dhabi', isActive: true, deliveryFee: 35, freeDeliveryThreshold: 350,
    freeDeliveryEnabled: true, expressAvailable: true, expressCutoffTime: '12:00', expressFee: 65,
    deliverySlots: [
      { id: 'ds-20', dayOfWeek: 0, label: '10 AM – 1 PM', startTime: '10:00', endTime: '13:00', capacity: 10, enabled: true },
      { id: 'ds-21', dayOfWeek: 0, label: '3 PM – 6 PM', startTime: '15:00', endTime: '18:00', capacity: 10, enabled: true },
      { id: 'ds-22', dayOfWeek: 1, label: '10 AM – 1 PM', startTime: '10:00', endTime: '13:00', capacity: 10, enabled: true },
      { id: 'ds-23', dayOfWeek: 2, label: '10 AM – 1 PM', startTime: '10:00', endTime: '13:00', capacity: 10, enabled: true },
      { id: 'ds-24', dayOfWeek: 3, label: '10 AM – 1 PM', startTime: '10:00', endTime: '13:00', capacity: 4, enabled: true },
      { id: 'ds-25', dayOfWeek: 4, label: '10 AM – 1 PM', startTime: '10:00', endTime: '13:00', capacity: 10, enabled: true },
      { id: 'ds-26', dayOfWeek: 5, label: '10 AM – 1 PM', startTime: '10:00', endTime: '13:00', capacity: 10, enabled: true },
    ],
  },
  {
    id: 'city-3', numericId: 3, name: 'Sharjah', isActive: true, deliveryFee: 30, freeDeliveryThreshold: 300,
    freeDeliveryEnabled: true, expressAvailable: false, expressFee: 0,
    deliverySlots: [
      { id: 'ds-30', dayOfWeek: 1, label: '11 AM – 2 PM', startTime: '11:00', endTime: '14:00', capacity: 8, enabled: true },
      { id: 'ds-31', dayOfWeek: 3, label: '11 AM – 2 PM', startTime: '11:00', endTime: '14:00', capacity: 8, enabled: true },
      { id: 'ds-32', dayOfWeek: 5, label: '11 AM – 2 PM', startTime: '11:00', endTime: '14:00', capacity: 8, enabled: true },
    ],
  },
  {
    id: 'city-4', numericId: 4, name: 'Beirut', isActive: true, deliveryFee: 15, freeDeliveryThreshold: 200,
    freeDeliveryEnabled: true, expressAvailable: false, expressFee: 0,
    deliverySlots: [
      { id: 'ds-40', dayOfWeek: 1, label: '10 AM – 2 PM', startTime: '10:00', endTime: '14:00', capacity: 12, enabled: true },
      { id: 'ds-41', dayOfWeek: 2, label: '10 AM – 2 PM', startTime: '10:00', endTime: '14:00', capacity: 12, enabled: true },
      { id: 'ds-42', dayOfWeek: 4, label: '10 AM – 2 PM', startTime: '10:00', endTime: '14:00', capacity: 12, enabled: true },
      { id: 'ds-43', dayOfWeek: 5, label: '10 AM – 2 PM', startTime: '10:00', endTime: '14:00', capacity: 12, enabled: true },
    ],
  },
  {
    id: 'city-5', numericId: 5, name: 'Riyadh', isActive: true, deliveryFee: 40, freeDeliveryThreshold: 400,
    freeDeliveryEnabled: false, expressAvailable: true, expressCutoffTime: '13:00', expressFee: 75,
    deliverySlots: [
      { id: 'ds-50', dayOfWeek: 0, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 10, enabled: true },
      { id: 'ds-51', dayOfWeek: 0, label: '2 PM – 4 PM', startTime: '14:00', endTime: '16:00', capacity: 10, enabled: true },
      { id: 'ds-52', dayOfWeek: 2, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 10, enabled: true },
      { id: 'ds-53', dayOfWeek: 4, label: '10 AM – 12 PM', startTime: '10:00', endTime: '12:00', capacity: 10, enabled: true },
    ],
  },
];

export const PRODUCTS: Product[] = [
  { id: 'p1', name: 'Classic Red Roses', category: 'Flowers', price: 150, image: 'https://images.unsplash.com/photo-1559181567-c3190ca9d715?w=400', availability: 'available', cities: ['Dubai', 'Abu Dhabi', 'Sharjah'], description: 'A stunning bouquet of 12 premium red roses', tags: ['romantic', 'popular'], variants: [{ id: 'v1', name: '6 Roses', price: 85 }, { id: 'v2', name: '12 Roses', price: 150 }, { id: 'v3', name: '24 Roses', price: 280 }] },
  { id: 'p2', name: 'Pastel Dream Bouquet', category: 'Flowers', price: 220, image: 'https://images.unsplash.com/photo-1490750967868-88df5691cc6e?w=400', availability: 'available', cities: ['Dubai', 'Abu Dhabi'], description: 'Mixed pastel flowers — peonies, lilies, and roses', tags: ['gift', 'birthday'] },
  { id: 'p3', name: 'Sunflower Joy', category: 'Flowers', price: 130, image: 'https://images.unsplash.com/photo-1597848212624-a19eb35e2651?w=400', availability: 'available', cities: ['Dubai', 'Sharjah', 'Beirut'], description: '10 vibrant sunflowers with greenery', tags: ['cheerful'] },
  { id: 'p4', name: 'Luxury Chocolate Box', category: 'Chocolates', price: 85, image: 'https://images.unsplash.com/photo-1549007994-cb92caebd54b?w=400', availability: 'available', cities: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Riyadh'], description: 'Assorted Belgian chocolates in premium box', tags: ['sweet', 'gift'] },
  { id: 'p5', name: 'Birthday Balloon Bundle', category: 'Balloons', price: 60, image: 'https://images.unsplash.com/photo-1527529482837-4698179dc6ce?w=400', availability: 'available', cities: ['Dubai', 'Abu Dhabi'], description: '5 premium helium balloons customized for birthday', tags: ['birthday'] },
  { id: 'p6', name: 'Monstera Plant', category: 'Plants', price: 180, image: 'https://images.unsplash.com/photo-1614594975525-e45190c55d0b?w=400', availability: 'available', cities: ['Dubai', 'Abu Dhabi', 'Sharjah'], description: 'Beautiful monstera in a ceramic pot', tags: ['plants', 'home'] },
  { id: 'p7', name: 'Velvet Cake', category: 'Cakes', price: 200, image: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=400', availability: 'available', cities: ['Dubai', 'Abu Dhabi'], description: 'Red velvet cake with cream cheese frosting', tags: ['birthday', 'sweet'], variants: [{ id: 'v4', name: '500g', price: 120 }, { id: 'v5', name: '1kg', price: 200 }, { id: 'v6', name: '2kg', price: 350 }] },
  { id: 'p8', name: 'Premium Greeting Card', category: 'Cards', price: 20, image: 'https://images.unsplash.com/photo-1607344645866-009c320b63e0?w=400', availability: 'available', cities: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Beirut', 'Riyadh'], description: 'Handmade premium greeting card', tags: ['card'] },
  { id: 'p9', name: 'White Orchid', category: 'Plants', price: 260, image: 'https://images.unsplash.com/photo-1569596082827-c61b0f01ca35?w=400', availability: 'available', cities: ['Dubai'], description: 'Elegant white orchid in luxury pot', tags: ['luxury', 'romantic'] },
  { id: 'p10', name: 'Mixed Spring Bouquet', category: 'Flowers', price: 175, image: 'https://images.unsplash.com/photo-1465146344425-f00d5f5c8f07?w=400', availability: 'out_of_stock', cities: ['Dubai', 'Abu Dhabi'], description: 'Seasonal spring flowers in pastel tones', tags: ['spring'] },
];

export const CUSTOMERS: Customer[] = [
  { id: 'c1', name: 'Nour Al-Rashidi', phone: '+971501234567', whatsapp: '+971501234567', email: 'nour@email.com', language: 'ar', isVip: true, totalOrders: 12, lifetimeSpend: 3400, lastOrderDate: '2026-05-10', notes: 'Prefers Arabic messages. Always tips driver.' },
  { id: 'c2', name: 'James Wilson', phone: '+971502345678', email: 'james.w@gmail.com', language: 'en', isVip: false, totalOrders: 3, lifetimeSpend: 650, lastOrderDate: '2026-04-22' },
  { id: 'c3', name: 'Lina Khoury', phone: '+9613456789', whatsapp: '+9613456789', language: 'ar', isVip: true, totalOrders: 28, lifetimeSpend: 8200, lastOrderDate: '2026-05-14', notes: 'VIP client. Always orders for corporate events.' },
  { id: 'c4', name: 'Omar Fayyad', phone: '+971503456789', language: 'en', isVip: false, totalOrders: 1, lifetimeSpend: 150, lastOrderDate: '2026-03-15' },
];

export const MOCK_ORDERS: Order[] = [
  {
    id: 'ord-1', orderNumber: '#2451', status: 'awaiting_payment', paymentStatus: 'awaiting_payment',
    source: 'whatsapp', isUrgent: false, hasIssue: false,
    customer: CUSTOMERS[0], recipient: { name: 'Rania Al-Rashidi', phone: '+971509876543', city: 'Dubai', area: 'Jumeirah', address: 'Villa 23, Al Wasl Road', notes: 'Leave at gate' },
    items: [{ id: 'oi-1', product: PRODUCTS[0], quantity: 1, unitPrice: 150 }],
    addOns: [{ id: 'ao-1', name: 'Greeting Card', price: 20, quantity: 1 }],
    occasion: 'Birthday', cardMessage: 'Happy Birthday dear Rania! 🎉',
    deliveryDate: '2026-05-17', deliveryTimeSlot: '2:00 PM - 4:00 PM',
    deliveryCity: DELIVERY_CITIES[0], deliveryFee: 25, expressFee: 0, discount: 0,
    subtotal: 170, total: 195, agentId: 'agent-1', agentName: 'Sarah Al-Hassan',
    paymentLink: 'https://pay.presentail.com/pay/abc123',
    createdAt: '2026-05-16T09:30:00Z', updatedAt: '2026-05-16T09:30:00Z',
  },
  {
    id: 'ord-2', orderNumber: '#2450', status: 'preparing', paymentStatus: 'paid',
    source: 'instagram', isUrgent: true, hasIssue: false,
    customer: CUSTOMERS[2], recipient: { name: 'CEO Office', phone: '+97142345678', city: 'Dubai', area: 'DIFC', address: 'Gate Building, Floor 12', notes: 'Security will need ID' },
    items: [{ id: 'oi-2', product: PRODUCTS[1], quantity: 2, unitPrice: 220 }, { id: 'oi-3', product: PRODUCTS[3], quantity: 1, unitPrice: 85 }],
    addOns: [],
    occasion: 'Congratulations', cardMessage: 'Congratulations on the new office!',
    deliveryDate: '2026-05-16', deliveryTimeSlot: '10:00 AM - 12:00 PM',
    deliveryCity: DELIVERY_CITIES[0], deliveryFee: 0, expressFee: 50, discount: 50,
    subtotal: 525, total: 525, agentId: 'agent-1', agentName: 'Sarah Al-Hassan',
    paymentMethod: 'payment_link',
    createdAt: '2026-05-15T16:00:00Z', updatedAt: '2026-05-16T08:00:00Z',
  },
  {
    id: 'ord-3', orderNumber: '#2449', status: 'with_driver', paymentStatus: 'paid',
    source: 'phone', isUrgent: false, hasIssue: false,
    customer: CUSTOMERS[1], recipient: { name: 'Emma Wilson', phone: '+971501112222', city: 'Abu Dhabi', area: 'Khalidiyah', address: 'Khalidiyah Street, Apt 4B' },
    items: [{ id: 'oi-4', product: PRODUCTS[6], quantity: 1, unitPrice: 200 }],
    addOns: [{ id: 'ao-2', name: 'Balloons', price: 40, quantity: 1 }],
    occasion: 'Birthday', cardMessage: 'Happy Birthday Emma!',
    deliveryDate: '2026-05-16', deliveryTimeSlot: '3:00 PM - 5:00 PM',
    deliveryCity: DELIVERY_CITIES[1], deliveryFee: 35, expressFee: 0, discount: 0,
    subtotal: 240, total: 275, agentId: 'agent-1', agentName: 'Sarah Al-Hassan',
    paymentMethod: 'card',
    createdAt: '2026-05-16T07:00:00Z', updatedAt: '2026-05-16T10:00:00Z',
  },
  {
    id: 'ord-4', orderNumber: '#2447', status: 'issue_reported', paymentStatus: 'paid',
    source: 'whatsapp', isUrgent: false, hasIssue: true, issueDescription: 'Customer says flowers arrived wilted',
    customer: CUSTOMERS[3], recipient: { name: 'Sara Fayyad', phone: '+971504567890', city: 'Sharjah', area: 'Al Majaz', address: 'Al Majaz Corniche, Building 5' },
    items: [{ id: 'oi-5', product: PRODUCTS[2], quantity: 1, unitPrice: 130 }],
    addOns: [],
    occasion: 'Love / Romance', cardMessage: 'For you, always.',
    deliveryDate: '2026-05-15', deliveryTimeSlot: '5:00 PM - 7:00 PM',
    deliveryCity: DELIVERY_CITIES[2], deliveryFee: 30, expressFee: 0, discount: 0,
    subtotal: 130, total: 160, agentId: 'agent-1', agentName: 'Sarah Al-Hassan',
    paymentMethod: 'payment_link',
    createdAt: '2026-05-14T14:00:00Z', updatedAt: '2026-05-15T19:00:00Z',
  },
  {
    id: 'ord-5', orderNumber: '#2445', status: 'delivered', paymentStatus: 'paid',
    source: 'website', isUrgent: false, hasIssue: false,
    customer: CUSTOMERS[0], recipient: { name: 'Ahmad Al-Rashidi', phone: '+971505678901', city: 'Dubai', area: 'Mirdif', address: 'Mirdif City Center, Villa 12' },
    items: [{ id: 'oi-6', product: PRODUCTS[5], quantity: 1, unitPrice: 180 }],
    addOns: [],
    occasion: 'Anniversary',
    deliveryDate: '2026-05-14', deliveryTimeSlot: '10:00 AM - 12:00 PM',
    deliveryCity: DELIVERY_CITIES[0], deliveryFee: 0, expressFee: 0, discount: 0,
    subtotal: 180, total: 180, agentId: 'agent-1', agentName: 'Sarah Al-Hassan',
    paymentMethod: 'cash',
    createdAt: '2026-05-13T11:00:00Z', updatedAt: '2026-05-14T11:30:00Z',
  },
  {
    id: 'ord-6', orderNumber: '#2448', status: 'draft', paymentStatus: 'draft',
    source: 'whatsapp', isUrgent: false, hasIssue: false,
    customer: CUSTOMERS[1], recipient: { name: 'Mike Johnson', phone: '+971506789012', city: 'Dubai', area: 'Business Bay', address: 'Bay Square, Block 7' },
    items: [],
    addOns: [],
    deliveryFee: 25, expressFee: 0, discount: 0, subtotal: 0, total: 25,
    agentId: 'agent-1', agentName: 'Sarah Al-Hassan',
    createdAt: '2026-05-16T11:00:00Z', updatedAt: '2026-05-16T11:00:00Z',
  },
];

export const CANNED_REPLIES: CannedReply[] = [
  { id: 'cr-1', category: 'Greeting', title: 'Welcome message', bodyEn: 'Hello! Welcome to Presentail 🌸 How can I help you today?', bodyAr: 'مرحباً! أهلاً بك في برزنتيل 🌸 كيف أقدر أساعدك اليوم؟' },
  { id: 'cr-2', category: 'Greeting', title: 'Returning customer', bodyEn: 'Welcome back {customer_name}! 😊 Lovely to hear from you again. How can I help you today?', bodyAr: 'أهلاً بعودتك {customer_name}! 😊 يسعدنا التواصل معك مرة أخرى. كيف أقدر أساعدك؟' },
  { id: 'cr-3', category: 'Order Update', title: 'Order confirmed', bodyEn: 'Great news! Your order {order_number} has been confirmed. 🎉 You will receive updates as it progresses.', bodyAr: 'أخبار رائعة! تم تأكيد طلبك {order_number}. 🎉 سنرسل لك تحديثات عند كل مرحلة.' },
  { id: 'cr-4', category: 'Order Update', title: 'Order is preparing', bodyEn: 'Your order {order_number} is now being prepared with love by our team! 💐', bodyAr: 'طلبك {order_number} يتم تحضيره الآن بكل عناية وحب من فريقنا! 💐' },
  { id: 'cr-5', category: 'Order Update', title: 'Out for delivery', bodyEn: 'Your order is on its way! 🚗 Estimated arrival: {eta}. The driver will contact the recipient shortly.', bodyAr: 'طلبك في الطريق! 🚗 الوصول المتوقع: {eta}. السائق سيتواصل مع المستلم قريباً.' },
  { id: 'cr-6', category: 'Order Update', title: 'Delivered', bodyEn: 'Your order {order_number} has been delivered successfully! 🎊 We hope your loved one enjoyed it!', bodyAr: 'تم توصيل طلبك {order_number} بنجاح! 🎊 نتمنى أن يكون قد أسعد من تحبه!' },
  { id: 'cr-7', category: 'Payment', title: 'Payment link sent', bodyEn: 'I have sent you a secure payment link for your order {order_number}. Total: AED {amount}. Please complete payment to confirm your order. 🔐', bodyAr: 'لقد أرسلت لك رابط دفع آمن لطلبك {order_number}. المجموع: {amount} درهم. يرجى إتمام الدفع لتأكيد طلبك. 🔐' },
  { id: 'cr-8', category: 'Payment', title: 'Payment reminder', bodyEn: 'Hi {customer_name}, friendly reminder that your payment for order {order_number} is still pending. Please click the link to complete your order. 😊', bodyAr: 'مرحباً {customer_name}، تذكير لطيف بأن دفعة طلبك {order_number} لا تزال معلقة. يرجى النقر على الرابط لإتمام طلبك. 😊' },
  { id: 'cr-9', category: 'Delay', title: 'Delay apology', bodyEn: 'Hi {customer_name}, I sincerely apologize for the delay with your order {order_number}. Your order will arrive by {eta}. We are very sorry for any inconvenience. 🙏', bodyAr: 'مرحباً {customer_name}، أعتذر بصدق عن التأخير في طلبك {order_number}. سيصل طلبك بحلول {eta}. نأسف جداً على أي إزعاج. 🙏' },
  { id: 'cr-10', category: 'Issues', title: 'Issue follow-up', bodyEn: 'Hi {customer_name}, we are truly sorry to hear about the issue with your order. Your satisfaction is our priority and we will make this right for you. 💛', bodyAr: 'مرحباً {customer_name}، نأسف جداً لسماع ذلك. رضاك يأتي أولاً وسنعالج هذا الأمر فوراً. 💛' },
  { id: 'cr-11', category: 'Closing', title: 'Closing message', bodyEn: 'Thank you for choosing Presentail! 🌸 Have a wonderful day and do not hesitate to reach out if you need anything. We are always here for you! 💛', bodyAr: 'شكراً لاختيارك برزنتيل! 🌸 نتمنى لك يوماً رائعاً، ولا تتردد في التواصل إذا احتجت أي شيء. نحن دائماً هنا لك! 💛' },
];

export const MOCK_REFUND_REQUESTS: RefundRequest[] = [
  { id: 'rf-1', orderId: 'ord-4', orderNumber: '#2447', customerName: 'Omar Fayyad', agentName: 'Sarah Al-Hassan', reasonCode: 'Damaged item', amount: 80, explanation: 'Customer received wilted flowers. Photos attached. Requesting 50% refund.', status: 'pending', createdAt: '2026-05-15T20:00:00Z' },
  { id: 'rf-2', orderId: 'ord-3', orderNumber: '#2449', customerName: 'James Wilson', agentName: 'Sarah Al-Hassan', reasonCode: 'Late delivery', percentage: 15, explanation: 'Delivery arrived 2 hours late for a birthday. Customer upset.', status: 'pending', createdAt: '2026-05-16T09:00:00Z' },
  { id: 'rf-3', orderId: 'ord-5', orderNumber: '#2445', customerName: 'Nour Al-Rashidi', agentName: 'Sarah Al-Hassan', reasonCode: 'Wrong item', amount: 180, explanation: 'Customer received the wrong plant variety.', status: 'approved', createdAt: '2026-05-14T15:00:00Z' },
];

export const ORDER_STATUSES = ['draft', 'awaiting_payment', 'paid', 'preparing', 'with_driver', 'delivered', 'issue_reported'] as const;

export const OCCASIONS = ['Birthday', 'Anniversary', 'Congratulations', 'Apology', 'Love / Romance', 'Sympathy', 'Thank You', 'New Baby', "Mother's Day", "Valentine's Day", 'Graduation', 'Get Well Soon', 'Corporate', 'Other'];

export const PRODUCT_CATEGORIES = ['All', 'Flowers', 'Gifts', 'Plants', 'Cakes', 'Balloons', 'Chocolates', 'Cards'];

export const ADD_ONS = [
  { id: 'ao-1', name: 'Greeting Card', price: 20, quantity: 0 },
  { id: 'ao-2', name: 'Balloon Bundle', price: 40, quantity: 0 },
  { id: 'ao-3', name: 'Chocolate Box', price: 50, quantity: 0 },
  { id: 'ao-4', name: 'Plush Teddy Bear', price: 65, quantity: 0 },
  { id: 'ao-5', name: 'Premium Vase', price: 45, quantity: 0 },
  { id: 'ao-6', name: 'Extra Ribbon', price: 10, quantity: 0 },
];

export const TIME_SLOTS = ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM', '1:00 PM - 3:00 PM', '3:00 PM - 5:00 PM', '5:00 PM - 7:00 PM', '7:00 PM - 9:00 PM'];
