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
        "https://your-firebase-project.web.app",
        "https://etuition-client.web.app"
    ],
    credentials: true
}));
app.use(express.json());

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
        const db = client.db("eTuitionBd");
        const userCollection = db.collection("users");
        const tuitionCollection = db.collection("tuitions");
        const applicationCollection = db.collection("applications");
        const paymentCollection = db.collection("payments");

        console.log("MongoDB Connected Successfully");

        // --- MIDDLEWARES ---
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

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const user = await userCollection.findOne({ email });
            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        };

        // --- AUTH & USERS ---
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        app.post('/users', async (req, res) => {
            const user = req.body;
            const existingUser = await userCollection.findOne({ email: user.email });
            if (existingUser) {
                return res.send({ message: 'user already exists', insertedId: null });
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        });

        // ✅ CRITICAL FIX: Handle case where user is not found (prevents JSON crash)
        app.get('/users/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const result = await userCollection.findOne({ email });
            
            // If user isn't in DB yet (e.g. fresh google login), return default role
            if (!result) {
                return res.send({ role: 'student' });
            }
            
            res.send(result);
        });

        app.patch('/users/update/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if(req.decoded.email !== email) return res.status(403).send({message: 'forbidden'});
            
            const updateDoc = {
                $set: {
                    name: req.body.name,
                    photoURL: req.body.photoURL
                }
            };
            const result = await userCollection.updateOne({ email }, updateDoc);
            res.send(result);
        });

        // --- PUBLIC ROUTES (Tuitions & Tutors) ---
        
        app.get('/tuitions', async (req, res) => {
            const result = await tuitionCollection.find({ status: 'approved' })
                .sort({ createdAt: -1 })
                .toArray();
            res.send(result);
        });

        app.get('/tuitions/:id', async (req, res) => {
            try {
                const result = await tuitionCollection.findOne({ _id: new ObjectId(req.params.id) });
                res.send(result);
            } catch(e) {
                res.status(404).send({message: "Not found"});
            }
        });

        app.get('/featured-tutors', async (req, res) => {
            const result = await userCollection.find({ role: { $regex: /^tutor$/i } }).limit(10).toArray();
            res.send(result);
        });

        app.get('/all-tutors', async (req, res) => {
            const result = await userCollection.find({ role: { $regex: /^tutor$/i } }).toArray();
            res.send(result);
        });

        app.get('/tutors/:id', async (req, res) => {
            try {
                const result = await userCollection.findOne({ _id: new ObjectId(req.params.id) });
                res.send(result);
            } catch(e) {
                res.status(404).send({message: "Tutor not found"});
            }
        });


        // --- STUDENT DASHBOARD ROUTES ---

        app.post('/tuitions', verifyToken, async (req, res) => {
            const item = req.body;
            item.status = 'pending';
            item.createdAt = new Date();
            const result = await tuitionCollection.insertOne(item);
            res.send(result);
        });

        app.get('/tuitions/student/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if(req.decoded.email !== email) return res.status(403).send({message: 'forbidden'});
            
            const result = await tuitionCollection.find({ studentEmail: email }).toArray();
            res.send(result);
        });

        app.patch('/tuitions/update/:id', verifyToken, async (req, res) => {
            const result = await tuitionCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: req.body }
            );
            res.send(result);
        });

        app.delete('/tuitions/:id', verifyToken, async (req, res) => {
            const result = await tuitionCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });

        app.get('/applications/received/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if(req.decoded.email !== email) return res.status(403).send({message: 'forbidden'});

            const result = await applicationCollection.aggregate([
                {
                    $lookup: {
                        from: 'tuitions',
                        localField: 'tuitionId',
                        foreignField: '_id',
                        as: 'tuitionData'
                    }
                },
                { $unwind: '$tuitionData' },
                { 
                    $match: { 
                        'tuitionData.studentEmail': email 
                    } 
                }
            ]).toArray();

            res.send(result);
        });

        // --- TUTOR DASHBOARD ROUTES ---

        app.post('/applications', verifyToken, async (req, res) => {
            const application = req.body;
            application.status = 'pending';
            
            const exists = await applicationCollection.findOne({ 
                tuitionId: application.tuitionId, 
                tutorEmail: application.tutorEmail 
            });
            
            if (exists) {
                return res.send({ message: 'Already applied', insertedId: null });
            }
            
            const result = await applicationCollection.insertOne(application);
            res.send(result);
        });

        app.get('/applications/tutor/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if(req.decoded.email !== email) return res.status(403).send({message: 'forbidden'});

            const result = await applicationCollection.aggregate([
                { $match: { tutorEmail: email } },
                {
                    $lookup: {
                        from: 'tuitions',
                        localField: 'tuitionId',
                        foreignField: '_id',
                        as: 'tuitionData'
                    }
                },
                { $unwind: { path: '$tuitionData', preserveNullAndEmptyArrays: true } } 
            ]).toArray();
            res.send(result);
        });

        app.delete('/applications/:id', verifyToken, async(req, res) => {
            const result = await applicationCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });


        // --- ADMIN ROUTES ---

        app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
            const result = await userCollection.find().toArray();
            res.send(result);
        });

        app.patch('/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const { role } = req.body;
            const result = await userCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { role: role } }
            );
            res.send(result);
        });

        app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
            const result = await userCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });

        app.get('/tuitions/admin/all', verifyToken, verifyAdmin, async (req, res) => {
            const result = await tuitionCollection.find().sort({ createdAt: -1 }).toArray();
            res.send(result);
        });

        app.patch('/tuitions/status/:id', verifyToken, verifyAdmin, async (req, res) => {
            const result = await tuitionCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: req.body.status } }
            );
            res.send(result);
        });

        app.patch('/applications/reject/:id', verifyToken, async(req, res) => {
             const result = await applicationCollection.updateOne(
                 { _id: new ObjectId(req.params.id) },
                 { $set: { status: 'rejected' } }
             );
             res.send(result);
        });

        app.get('/admin-stats', verifyToken, verifyAdmin, async(req, res) => {
            const users = await userCollection.estimatedDocumentCount();
            const tuitions = await tuitionCollection.estimatedDocumentCount();
            const applications = await applicationCollection.estimatedDocumentCount();
            const payments = await paymentCollection.aggregate([
                { $group: { _id: null, totalRevenue: { $sum: '$price' } } }
            ]).toArray();
            const revenue = payments.length > 0 ? payments[0].totalRevenue : 0;
            res.send({ users, tuitions, applications, revenue });
        });


        // --- PAYMENT ROUTES ---

        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const { price } = req.body;
            if(!price) return res.status(400).send({error: "Price is required"});

            const amount = parseInt(price * 100);
            
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd', 
                payment_method_types: ['card']
            });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post('/payments', verifyToken, async (req, res) => {
            const payment = req.body;
            
            // 1. Fetch the application to get the tutor's email
            const application = await applicationCollection.findOne({ _id: new ObjectId(payment.applicationId) });
            
            if (application) {
                payment.tutorEmail = application.tutorEmail; // Add tutor email to payment record
            }

            const paymentResult = await paymentCollection.insertOne(payment);
            
            // 2. Mark application as approved
            const appResult = await applicationCollection.updateOne(
                { _id: new ObjectId(payment.applicationId) },
                { $set: { status: 'approved' } }
            );
            res.send({ paymentResult, appResult });
        });

        app.get('/payments/my-history/:email', verifyToken, async (req, res) => {
            if(req.decoded.email !== req.params.email) return res.status(403).send({message: 'forbidden'});
            const result = await paymentCollection.find({ email: req.params.email }).toArray();
            res.send(result);
        });

        // ✅ FIX: Safe filter by tutorEmail
        app.get('/payments/tutor-history/:email', verifyToken, async (req, res) => {
            if(req.decoded.email !== req.params.email) return res.status(403).send({message: 'forbidden'});
            
            const result = await paymentCollection.find({ tutorEmail: req.params.email }).toArray(); 
            res.send(result); 
        });

        await client.db("admin").command({ ping: 1 });
        console.log("MongoDB Connected Successfully!");

    } finally {
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