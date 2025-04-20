require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const mongoose = require("mongoose");
const socketio = require("socket.io");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.static("public"));
app.use(express.json());

// Check environment variables before starting
if (!process.env.PAYSTACK_SECRET_KEY) {
  console.error("FATAL ERROR: PAYSTACK_SECRET_KEY is missing in .env file");
  process.exit(1);
}

// Database connection
mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;

db.on("error", (err) => console.error("MongoDB connection error:", err));
db.once("open", async () => {
  console.log("Connected to MongoDB");
  await initializeMenu();
});

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: { maxAge: 86400000 },
  })
);

// Define schemas
const menuItemSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Menu item name is required"],
    trim: true,
    minlength: [3, "Menu item name must be at least 3 characters"],
  },
  price: {
    type: Number,
    required: true,
    min: [100, "Price cannot be less than ₦100"],
    max: [10000, "Price cannot exceed ₦10,000"],
  },
  description: {
    type: String,
    trim: true,
    maxlength: [100, "Description cannot exceed 100 characters"],
  },
});

const orderSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      match: [/^[0-9a-fA-F-]{36}$/, "Invalid session ID"],
    },
    items: [
      {
        menuItemId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "MenuItem",
          required: true,
        },
        name: String,
        price: Number,
        quantity: Number,
      },
    ],
    total: {
      type: Number,
      required: true,
      min: [100, "Total must be at least ₦100"],
    },
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled"],
      default: "pending",
    },
    paymentReference: String,
  },
  { timestamps: true }
);

const MenuItem = mongoose.model("MenuItem", menuItemSchema);
const Order = mongoose.model("Order", orderSchema);

// Initialize sample menu
async function initializeMenu() {
  try {
    const count = await MenuItem.countDocuments();
    if (count === 0) {
      await MenuItem.insertMany([
        {
          name: "Jollof Rice",
          price: 1500,
          description: "Classic Nigerian Jollof",
        },
        { name: "Pounded Yam", price: 2000, description: "With Egusi Soup" },
        {
          name: "Chicken Suya",
          price: 1200,
          description: "Spicy grilled chicken",
        },
        {
          name: "Chapman Cocktail",
          price: 800,
          description: "Signature drink",
        },
      ]);
      console.log("Sample menu items created");
    }
  } catch (err) {
    console.error("Menu initialization error:", err);
  }
}

// Create server
const server = app.listen(9000, () => {
  console.log("Server running on port 9000");
});

// Socket.io setup
const io = socketio(server);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  resave: false,
  saveUninitialized: true,
});

// Chatbot logic
io.on("connection", (socket) => {
  const req = socket.request;

  // Clear previous session data on new connection
  req.session.regenerate((err) => {
    if (err) console.error("Session regeneration error:", err);

    req.session.sessionId = uuidv4();
    req.session.currentOrder = [];
    req.session.save();
  });

  // Handle session clearing from payment completion
  socket.on("clear-session", (sessionId) => {
    if (req.session.sessionId === sessionId) {
      req.session.regenerate(() => {
        req.session.sessionId = uuidv4();
        req.session.currentOrder = [];
        req.session.save();
        sendOptions(); // Resend initial options
      });
    }
  });

  const sendOptions = () => {
    socket.emit(
      "bot-message",
      `\nPlease choose an option:
1. Place new order
99. Checkout order
98. Order history
97. Current order
0. Cancel order`
    );
  };

  const showMenu = async () => {
    try {
      await Order.deleteMany({
        sessionId: req.session.sessionId,
        status: "pending",
      });

      const menuItems = await MenuItem.find();
      const menuMessage = menuItems
        .map(
          (item, index) =>
            `${index + 1}. ${item.name} - ₦${item.price}\n   ${
              item.description
            }`
        )
        .join("\n\n");

      socket.emit(
        "bot-message",
        `Our Menu:\n${menuMessage}\n\nEnter item numbers separated by commas (e.g., 1,3)`
      );
      req.session.currentOrder = [];
      req.session.save();
    } catch (err) {
      console.error(err);
      socket.emit("bot-message", "Error loading menu. Please try again.");
    }
  };

  // Initial greeting
  socket.emit("bot-message", "Welcome to Altschool RestaurantBot!");
  sendOptions();

  socket.on("user-message", async (input) => {
    try {
      const cleanedInput = input.toString().trim();

      // Input validation
      if (!cleanedInput.match(/^(0|1|97|98|99|\d+(,\d+)*)$/)) {
        socket.emit(
          "bot-message",
          "❌ Invalid input. Please use only numbers and commas."
        );
        return sendOptions();
      }

      switch (cleanedInput) {
        case "1":
          try {
            // Clear previous order data
            req.session.currentOrder = [];
            await req.session.save();

            // Get and display menu
            const menuItems = await MenuItem.find();
            const menuMessage = menuItems
              .map(
                (item, index) =>
                  `${index + 1}. ${item.name} - ₦${item.price}\n   ${
                    item.description
                  }`
              )
              .join("\n\n");

            // Send menu without showing options
            socket.emit(
              "bot-message",
              `📜 Menu:\n${menuMessage}\n\n` +
                "Enter item numbers separated by commas (e.g. 1,3):"
            );

            // Set flag to indicate we're expecting item selection
            req.session.awaitingItemSelection = true;
            await req.session.save();
          } catch (error) {
            console.error("Menu Error:", error);
            socket.emit("bot-message", "⚠️ Error loading menu");
            sendOptions();
          }
          break; // Add break here

        case "99":
          try {
            let activeOrder;

            // Check for session order first
            if (req.session.currentOrder?.length > 0) {
              const items = await MenuItem.find({
                _id: { $in: req.session.currentOrder },
              });

              // Validate menu items exist
              if (items.length !== req.session.currentOrder.length) {
                socket.emit(
                  "bot-message",
                  "⚠️ Some items are no longer available. Please create a new order."
                );
                req.session.currentOrder = [];
                req.session.save();
                return sendOptions();
              }

              // Create new order with explicit status
              activeOrder = new Order({
                sessionId: req.session.sessionId,
                items: items.map((item) => ({
                  menuItemId: item._id,
                  name: item.name,
                  price: item.price,
                  quantity: 1,
                })),
                total: items.reduce((sum, item) => sum + item.price, 0),
                status: "pending",
              });

              await activeOrder.save();
              req.session.currentOrder = [];
              req.session.save();
            } else {
              // Find existing pending order
              activeOrder = await Order.findOne({
                sessionId: req.session.sessionId,
                status: "pending",
              });
            }

            if (!activeOrder) {
              socket.emit("bot-message", "🛒 No order to place");
              return sendOptions();
            }

            // Validate total amount
            if (activeOrder.total < 100) {
              socket.emit("bot-message", "⚠️ Minimum order amount is ₦100");
              return sendOptions();
            }

            // Initiate payment
            const paymentData = {
              email: "customer@example.com",
              amount: activeOrder.total * 100,
              reference: `order_${activeOrder._id}`,
              callback_url: "http://localhost:9000/payment/callback",
            };

            // Validate Paystack key exists
            if (!process.env.PAYSTACK_SECRET_KEY) {
              console.error("Paystack secret key missing");
              socket.emit(
                "bot-message",
                "⚠️ Payment service unavailable. Please try later."
              );
              return sendOptions();
            }
            // Add this debug log to verify the key
            console.log(
              "Using Paystack Key:",
              process.env.PAYSTACK_SECRET_KEY?.slice(0, 8) + "****"
            );

            const response = await axios.post(
              "https://api.paystack.co/transaction/initialize",
              paymentData,
              {
                headers: {
                  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                  "Content-Type": "application/json",
                },
                timeout: 10000, // 10-second timeout
              }
            );

            // Validate Paystack response
            if (!response?.data?.data?.authorization_url) {
              throw new Error("Invalid Paystack response");
            }

            // Update order with payment reference
            activeOrder.paymentReference = paymentData.reference;
            await activeOrder.save();

            // Redirect to payment page
            socket.emit("redirect", response.data.data.authorization_url);
          } catch (error) {
            console.error(
              "Checkout Error:",
              error.response?.data || error.message
            );

            // User-friendly error messages
            const errorMessage = error.response?.data?.message
              ? `Payment error: ${error.response.data.message}`
              : "⚠️ Payment processing failed. Please try again.";

            socket.emit("bot-message", errorMessage);
            sendOptions();

            // Optional: Cancel the pending order
            await Order.deleteOne({
              _id: activeOrder?._id,
              status: "pending",
            });
          }
          break;

        case "98":
          const orders = await Order.find({
            sessionId: req.session.sessionId,
            status: { $ne: "pending" },
          }).sort({ createdAt: -1 });

          if (orders.length === 0) {
            socket.emit("bot-message", "📜 No order history found");
          } else {
            const history = orders
              .map(
                (order) =>
                  `Order #${
                    order._id
                  }\n📅 ${order.createdAt.toLocaleString()}\n🍔 Items: ${order.items
                    .map((i) => i.name)
                    .join(", ")}\n💵 Total: ₦${order.total}\n📦 Status: ${
                    order.status
                  }`
              )
              .join("\n\n");
            socket.emit("bot-message", `Your Order History:\n${history}`);
          }
          sendOptions();
          break;

        case "97":
          if (!req.session.currentOrder?.length) {
            const currentOrder = await Order.findOne({
              sessionId: req.session.sessionId,
              status: "pending",
            });

            if (currentOrder) {
              const itemsList = currentOrder.items
                .map(
                  (item, index) => `${index + 1}. ${item.name} - ₦${item.price}`
                )
                .join("\n");
              socket.emit(
                "bot-message",
                `Current Pending Order:\n${itemsList}\nTotal: ₦${currentOrder.total}`
              );
            } else {
              socket.emit("bot-message", "🛒 No current order");
            }
          } else {
            const items = await MenuItem.find({
              _id: { $in: req.session.currentOrder },
            });
            const total = items.reduce((sum, item) => sum + item.price, 0);
            const itemsList = items
              .map(
                (item, index) => `${index + 1}. ${item.name} - ₦${item.price}`
              )
              .join("\n");
            socket.emit(
              "bot-message",
              `Current Order:\n${itemsList}\nTotal: ₦${total}`
            );
          }
          sendOptions();
          break;

        case "0":
          await Order.deleteMany({
            sessionId: req.session.sessionId,
            status: "pending",
          });
          req.session.currentOrder = [];
          req.session.save();
          socket.emit("bot-message", "❌ Order cancelled successfully");
          sendOptions();
          break;

        default:
          try {
            if (req.session.awaitingItemSelection) {
              // Process item selection
              const selectedItems = cleanedInput
                .split(",")
                .map((num) => parseInt(num.trim()))
                .filter((num) => !isNaN(num));

              const menuItems = await MenuItem.find();
              const validItems = selectedItems
                .map((num) => num - 1)
                .filter((index) => index >= 0 && index < menuItems.length)
                .map((index) => menuItems[index]._id);

              if (validItems.length > 0) {
                req.session.currentOrder = validItems;
                req.session.awaitingItemSelection = false;
                await req.session.save();

                socket.emit(
                  "bot-message",
                  `✅ Added ${validItems.length} item(s) to your order!\n` +
                    `Current order total: ₦${validItems.reduce((sum, id) => {
                      const item = menuItems.find((i) => i._id.equals(id));
                      return sum + (item?.price || 0);
                    }, 0)}`
                );
              } else {
                socket.emit("bot-message", "❌ Invalid item selection");
              }

              // Now show options after processing items
              sendOptions();
            }
          } catch (error) {
            console.error("Selection Error:", error);
            socket.emit("bot-message", "⚠️ Error processing selection");
            sendOptions();
          }
          break;
      }
    } catch (err) {
      console.error(err);
      socket.emit("bot-message", "⚠️ An error occurred. Please try again.");
      sendOptions();
    }
  });
});

// Payment callback handler (GET only - Paystack uses GET for callbacks)
app.get("/payment/callback", async (req, res) => {
  try {
    const reference = req.query.reference;

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      }
    );

    if (response.data.data.status === "success") {
      const order = await Order.findOneAndUpdate(
        { paymentReference: reference },
        { status: "paid" },
        { new: true }
      );

      // Redirect with payment reference instead of session ID
      res.redirect(`/receipt?reference=${reference}`);

      // Clear session data for new orders
      io.emit("clear-session", order.sessionId);
    }
  } catch (err) {
    console.error("Payment callback error:", err);
    res.redirect("/?payment=error");
  }
});

// Add receipt route before the root route
app.get("/receipt", async (req, res) => {
  try {
    const paymentReference = req.query.reference;

    const order = await Order.findOne({
      paymentReference,
      status: "paid",
    }).populate("items.menuItemId");

    if (!order) {
      return res.status(404).send("Order not found");
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Receipt - Altschool Restaurant</title>
        <style>
          /* Base styles */
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', system-ui, sans-serif;
          }

          body {
            background: #f8fafc;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 2rem;
          }

          /* Receipt container */
          .receipt-container {
            background: white;
            width: 100%;
            max-width: 600px;
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            padding: 2.5rem;
            position: relative;
            overflow: hidden;
          }

          /* Header section */
          .receipt-header {
            text-align: center;
            margin-bottom: 2rem;
          }

          .restaurant-name {
            color: #2c3e50;
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
          }

          .success-badge {
            background: #27ae60;
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 50px;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            font-weight: 600;
            margin: 1rem 0;
          }

          /* Items list */
          .items-list {
            margin: 2rem 0;
            border-top: 2px solid #f1f5f9;
            padding-top: 1.5rem;
          }

          .item-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 0;
            border-bottom: 1px solid #f1f5f9;
          }

          .item-name {
            color: #2c3e50;
            font-weight: 500;
          }

          .item-price {
            color: #27ae60;
            font-weight: 600;
          }

          /* Total section */
          .total-section {
            margin-top: 2rem;
            padding-top: 1.5rem;
            border-top: 2px solid #f1f5f9;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .total-label {
            font-size: 1.1rem;
            color: #64748b;
          }

          .total-amount {
            font-size: 1.5rem;
            color: #27ae60;
            font-weight: 700;
          }

          /* Meta data */
          .meta-section {
            margin-top: 2rem;
            color: #64748b;
            font-size: 0.9rem;
            line-height: 1.6;
          }

          /* Back link */
          .back-link {
            display: inline-block;
            margin-top: 2rem;
            padding: 1rem 2rem;
            background: #3498db;
            color: white;
            text-decoration: none;
            border-radius: 50px;
            transition: all 0.2s ease;
            font-weight: 500;
          }

          .back-link:hover {
            background: #2980b9;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(52,152,219,0.3);
          }

          /* Watermark */
          .watermark {
            position: absolute;
            opacity: 0.05;
            font-size: 6rem;
            font-weight: 900;
            color: #2c3e50;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            pointer-events: none;
            user-select: none;
          }

          /* Responsive design */
          @media (max-width: 640px) {
            body {
              padding: 1rem;
            }

            .receipt-container {
              padding: 1.5rem;
            }

            .restaurant-name {
              font-size: 1.5rem;
            }

            .watermark {
              font-size: 4rem;
            }
          }
        </style>
      </head>
      <body>
        <div class="receipt-container">
          <div class="watermark">ALTSCHOOL</div>
          
          <div class="receipt-header">
            <h1 class="restaurant-name">🍴 Altschool Restaurant</h1>
            <div class="success-badge">
              ✅ Payment Successful
            </div>
          </div>

          <div class="items-list">
            ${order.items
              .map(
                (item) => `
              <div class="item-row">
                <span class="item-name">${item.name}</span>
                <span class="item-price">₦${item.price.toLocaleString()}</span>
              </div>
            `
              )
              .join("")}
          </div>

          <div class="total-section">
            <span class="total-label">Total Amount:</span>
            <span class="total-amount">₦${order.total.toLocaleString()}</span>
          </div>

          <div class="meta-section">
            <p>Payment Reference: ${paymentReference}</p>
            <p>Session ID: ${order.sessionId}</p>
            <p>Payment Date: ${new Date(order.updatedAt).toLocaleDateString(
              "en-US",
              {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }
            )}</p>
          </div>

          <a href="/" class="back-link">Start New Order →</a>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Receipt error:", error);
    res.status(500).send("Error generating receipt");
  }
});

// Serve main page with payment status handling
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});
