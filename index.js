const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: [
        "http://localhost:5173",
        "https://your-firebase-project.web.app" // Add your live link here later
    ],
    credentials: true
}));
app.use(express.json());

// MongoDB Connection
// PASTE THIS INSTEAD:
const uri = process.env.MONGO_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server
        // await client.connect(); // Optional in Vercel/Serverless but good for local
        
        const db = client.db("eTuitionBd");
        const userCollection = db.collection("users");
        const tuitionCollection = db.collection("tuitions");
        const applicationCollection = db.collection("applications");
        const paymentCollection = db.collection("payments");

        // --------------------------------------------------------
        // MIDDLEWARES (Security Layer)
        // --------------------------------------------------------

        // 1. Verify Token (JWT)
        const verifyToken = (req, res, next) => {
            if (!req.headers.authorization) {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'unauthorized access' });
                }
                req.decoded = decoded;
                next();
            });
        };

        // 2. Verify Admin
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isAdmin = user?.role === 'admin';
            if (!isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        };

        // 3. Verify Tutor
        const verifyTutor = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isTutor = user?.role === 'tutor';
            if (!isTutor) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        };

        // --------------------------------------------------------
        // AUTHENTICATION ROUTES
        // --------------------------------------------------------

        // Generate JWT Token
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        // Save User (Google Login / Register)
        app.post('/users', async (req, res) => {
            const user = req.body;
            // Check if user exists
            const query = { email: user.email };
            const existingUser = await userCollection.findOne(query);
            if (existingUser) {
                return res.send({ message: 'user already exists', insertedId: null });
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        });

        // Get User Role & Info
        app.get('/users/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const query = { email: email };
            const user = await userCollection.findOne(query);
            res.send(user);
        });

        // --------------------------------------------------------
        // TUITION ROUTES (Public & Student)
        // --------------------------------------------------------

        // Get All Tuitions (Public + Challenge: Search, Sort, Pagination)
        app.get('/tuitions', async (req, res) => {
            const page = parseInt(req.query.page) || 0;
            const limit = parseInt(req.query.limit) || 9;
            const search = req.query.search || "";
            const sort = req.query.sort; // 'asc' or 'desc' for budget

            // Search by Subject or Location
            const query = {
                status: 'approved', // Only show approved tuitions
                $or: [
                    { subject: { $regex: search, $options: 'i' } },
                    { location: { $regex: search, $options: 'i' } }
                ]
            };

            let options = {};
            if (sort) {
                options = { sort: { budget: sort === 'asc' ? 1 : -1 } };
            }

            const result = await tuitionCollection.find(query, options)
                .skip(page * limit)
                .limit(limit)
                .toArray();
            
            // Send total count for pagination
            const total = await tuitionCollection.countDocuments(query);

            res.send({
                result,
                total
            });
        });

        // Get Single Tuition Details
        app.get('/tuitions/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await tuitionCollection.findOne(query);
            res.send(result);
        });

        // Post a Tuition (Student Only)
        app.post('/tuitions', verifyToken, async (req, res) => {
            const item = req.body;
            item.status = 'pending'; // Default status
            item.createdAt = new Date();
            const result = await tuitionCollection.insertOne(item);
            res.send(result);
        });

        // Get My Tuitions (Student)
        app.get('/my-tuitions/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const query = { email: email }; // Assuming 'email' is the field for creator
            const result = await tuitionCollection.find(query).toArray();
            res.send(result);
        });

        // Delete Tuition (Student)
        app.delete('/tuitions/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await tuitionCollection.deleteOne(query);
            res.send(result);
        });

        // Update Tuition (Student)
        app.patch('/tuitions/update/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: req.body
            }
            const result = await tuitionCollection.updateOne(filter, updatedDoc);
            res.send(result);
        });


        // --------------------------------------------------------
        // APPLICATION ROUTES (The Logic Core)
        // --------------------------------------------------------

        // Apply for Tuition (Tutor)
        app.post('/applications', verifyToken, verifyTutor, async (req, res) => {
            const application = req.body;
            // Prevent duplicate application
            const query = { 
                tuitionId: application.tuitionId, 
                tutorEmail: application.tutorEmail 
            };
            const existingApp = await applicationCollection.findOne(query);
            if (existingApp) {
                return res.status(400).send({ message: 'Already applied' });
            }
            const result = await applicationCollection.insertOne(application);
            res.send(result);
        });

        // Get Applications for My Tuition (Student)
        app.get('/applications/tuition/:tuitionId', verifyToken, async (req, res) => {
            const tuitionId = req.params.tuitionId;
            const query = { tuitionId: tuitionId };
            const result = await applicationCollection.find(query).toArray();
            res.send(result);
        });

        // Get My Applications (Tutor)
        app.get('/my-applications/:email', verifyToken, verifyTutor, async (req, res) => {
            const email = req.params.email;
            const query = { tutorEmail: email };
            const result = await applicationCollection.find(query).toArray();
            res.send(result);
        });

        // Reject Application (Student)
        app.patch('/applications/reject/:id', verifyToken, async(req, res) => {
             const id = req.params.id;
             const query = { _id: new ObjectId(id) };
             const updatedDoc = {
                 $set: { status: 'rejected' }
             }
             const result = await applicationCollection.updateOne(query, updatedDoc);
             res.send(result);
        });


        // --------------------------------------------------------
        // ADMIN ROUTES
        // --------------------------------------------------------

        // Get All Users
        app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
            const result = await userCollection.find().toArray();
            res.send(result);
        });

        // Make Admin/Tutor
        app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: { role: req.body.role } // 'admin' or 'tutor' or 'student'
            };
            const result = await userCollection.updateOne(filter, updatedDoc);
            res.send(result);
        });

        // Approve/Reject Tuition (Admin)
        app.patch('/tuitions/status/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: { status: req.body.status } // 'approved' or 'rejected'
            };
            const result = await tuitionCollection.updateOne(filter, updatedDoc);
            res.send(result);
        });

        // Admin Stats
        app.get('/admin-stats', verifyToken, verifyAdmin, async(req, res) => {
            const users = await userCollection.estimatedDocumentCount();
            const tuitions = await tuitionCollection.estimatedDocumentCount();
            const applications = await applicationCollection.estimatedDocumentCount();
            
            // Calculate total revenue from payments collection
            const payments = await paymentCollection.aggregate([
                { $group: { _id: null, totalRevenue: { $sum: '$price' } } }
            ]).toArray();
            const revenue = payments.length > 0 ? payments[0].totalRevenue : 0;

            res.send({ users, tuitions, applications, revenue });
        })


        // --------------------------------------------------------
        // PAYMENT INTENT (Stripe)
        // --------------------------------------------------------
        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const { price } = req.body;
            const amount = parseInt(price * 100); // Stripe works in cents
            
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: ['card']
            });

            res.send({
                clientSecret: paymentIntent.client_secret
            });
        });

        // Save Payment Info & Approve Tutor Application
        app.post('/payments', verifyToken, async (req, res) => {
            const payment = req.body;
            // 1. Save payment
            const paymentResult = await paymentCollection.insertOne(payment);
            
            // 2. Update the specific application status to 'approved'
            const query = { _id: new ObjectId(payment.applicationId) };
            const updatedDoc = {
                $set: { status: 'approved' }
            };
            const appResult = await applicationCollection.updateOne(query, updatedDoc);

            // 3. (Optional) Reject other applications for this tuition?
            // Requires logic to find other apps with same tuitionId and set to rejected

            res.send({ paymentResult, appResult });
        });


        // Ping to confirm connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('eTuitionBd Server is Running');
});

app.listen(port, () => {
    console.log(`Server is running on port: ${port}`);
});