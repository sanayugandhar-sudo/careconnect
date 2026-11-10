import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db } from './server/db.js';
import { suggestDepartmentWithAI } from './server/ai.js';
import { StaffUser } from './src/types/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// In-memory token store for authenticated staff sessions
function generateSessionToken(user: StaffUser): string {
  const token = `care_sess_${user.id}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  db.createSession(token, user);
  return token;
}

// Authentication middleware
function requireAuth(allowedRoles?: ('receptionist' | 'admin')[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: Authentication required' });
      return;
    }
    const token = authHeader.split(' ')[1];
    const user = db.getSession(token);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Session expired or invalid' });
      return;
    }
    if (allowedRoles && !allowedRoles.includes(user.role)) {
      res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
      return;
    }
    (req as any).user = user;
    next();
  };
}

// ---------------- PUBLIC PATIENT API ROUTES ----------------

// Get hospital information
app.get('/api/hospital-info', (req: Request, res: Response) => {
  res.json(db.getHospitalInfo());
});

// Get active departments
app.get('/api/departments', (req: Request, res: Response) => {
  res.json(db.getDepartments());
});

// Get available doctors (optionally filtered by department)
app.get('/api/doctors', (req: Request, res: Response) => {
  const departmentId = req.query.departmentId as string | undefined;
  res.json(db.getDoctors(departmentId));
});

// Get doctor slot schedule and booked status for a date
app.get('/api/doctors/slots', (req: Request, res: Response) => {
  const doctorId = req.query.doctorId as string;
  const date = req.query.date as string;

  if (!doctorId || !date) {
    res.status(400).json({ error: 'doctorId and date query parameters are required' });
    return;
  }

  const doctor = db.getDoctorById(doctorId);
  if (!doctor) {
    res.status(404).json({ error: 'Doctor not found' });
    return;
  }

  const bookedSlots = db.getBookedSlotsForDoctor(doctorId, date);
  const slotsWithStatus = doctor.availableSlots.map((slot) => ({
    time: slot,
    isBooked: bookedSlots.includes(slot),
  }));

  res.json({
    doctorId,
    date,
    slots: slotsWithStatus,
  });
});

// Patient Self-Registration (from home)
app.post('/api/registrations/online', async (req: Request, res: Response) => {
  try {
    const {
      fullName,
      age,
      gender,
      mobileNumber,
      address,
      bloodGroup,
      departmentId,
      doctorId,
      appointmentDate,
      appointmentTime,
      symptomsNotes,
    } = req.body;

    if (!fullName || !age || !gender || !mobileNumber || !address || !departmentId || !doctorId || !appointmentDate || !appointmentTime) {
      res.status(400).json({ error: 'Please provide all mandatory patient and appointment fields.' });
      return;
    }

    const reg = await db.registerOP({
      patientDetails: {
        fullName: fullName.trim(),
        age: parseInt(age, 10),
        gender,
        mobileNumber: mobileNumber.trim(),
        address: address.trim(),
        bloodGroup,
      },
      departmentId,
      doctorId,
      appointmentDate,
      appointmentTime,
      registrationType: 'online',
      registeredBy: 'patient_self',
      symptomsNotes,
      initialStatus: 'Registered',
      paymentStatus: 'Online Confirmed',
    });

    res.status(201).json({
      success: true,
      registration: reg,
      message: 'Online OP registration successful! Your OP Slip has been generated.',
    });
  } catch (error: any) {
    console.error('Error during online OP registration:', error);
    res.status(400).json({ error: error.message || 'Failed to complete registration' });
  }
});

// Lookup OP registration (strictly requires OP Number + registered mobile number to prevent unauthenticated record exposure)
app.post('/api/registrations/lookup', (req: Request, res: Response) => {
  const { opNumber, mobileNumber } = req.body;
  if (!opNumber || !mobileNumber) {
    res.status(400).json({ error: 'Both OP Registration Number and registered Mobile Number are required.' });
    return;
  }

  const record = db.lookupRegistration(opNumber, mobileNumber);
  if (!record) {
    res.status(404).json({
      error: 'No matching record found. Please verify your OP Number and registered mobile number.',
    });
    return;
  }

  res.json({
    success: true,
    registration: record,
  });
});

// AI Department Triage Assistant
app.post('/api/ai/suggest-department', async (req: Request, res: Response) => {
  const { symptoms, age, gender } = req.body;
  if (!symptoms || typeof symptoms !== 'string' || symptoms.trim().length < 3) {
    res.status(400).json({ error: 'Please describe your symptoms in at least a few words.' });
    return;
  }

  try {
    const suggestion = await suggestDepartmentWithAI(symptoms, age, gender);
    res.json(suggestion);
  } catch (err: any) {
    console.error('Error in AI suggestion endpoint:', err);
    res.status(500).json({ error: 'Could not generate suggestion at this time.' });
  }
});

// ---------------- AUTHENTICATION API ROUTES ----------------

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const user = db.authenticateStaff(email, password);
  if (!user) {
    res.status(401).json({ error: 'Invalid staff email or password' });
    return;
  }

  const token = generateSessionToken(user);
  res.json({
    success: true,
    user,
    token,
  });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const token = authHeader.split(' ')[1];
  const user = db.getSession(token);
  if (!user) {
    res.status(401).json({ error: 'Session expired' });
    return;
  }
  res.json({ user });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    db.deleteSession(token);
  }
  res.json({ success: true });
});

// ---------------- RECEPTION COUNTER & ADMIN ROUTES ----------------

// Search existing patients by name or mobile (Reception desk duplicate avoidance)
app.get(
  '/api/patients/search',
  requireAuth(['receptionist', 'admin']),
  (req: Request, res: Response) => {
    const q = (req.query.q as string) || '';
    const results = db.searchPatients(q);
    res.json(results);
  }
);

// Register walk-in patient at counter
app.post(
  '/api/registrations/walk-in',
  requireAuth(['receptionist', 'admin']),
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user as StaffUser;
      const {
        fullName,
        age,
        gender,
        mobileNumber,
        address,
        bloodGroup,
        departmentId,
        doctorId,
        appointmentDate,
        appointmentTime,
        symptomsNotes,
        initialStatus,
      } = req.body;

      if (!fullName || !age || !gender || !mobileNumber || !address || !departmentId || !doctorId) {
        res.status(400).json({ error: 'Please fill in all mandatory patient fields.' });
        return;
      }

      const today = new Date().toISOString().split('T')[0];
      const targetDate = appointmentDate || today;
      const targetTime = appointmentTime || 'Immediate / Next Walk-in';

      const reg = await db.registerOP({
        patientDetails: {
          fullName: fullName.trim(),
          age: parseInt(age, 10),
          gender,
          mobileNumber: mobileNumber.trim(),
          address: address.trim(),
          bloodGroup,
        },
        departmentId,
        doctorId,
        appointmentDate: targetDate,
        appointmentTime: targetTime,
        registrationType: 'walk-in',
        registeredBy: user.role === 'admin' ? 'admin' : 'receptionist',
        symptomsNotes,
        initialStatus: initialStatus || 'Waiting',
        paymentStatus: 'Paid at Counter',
      });

      res.status(201).json({
        success: true,
        registration: reg,
        message: 'Walk-in OP registration generated! Token allocated.',
      });
    } catch (error: any) {
      console.error('Error during walk-in OP registration:', error);
      res.status(400).json({ error: error.message || 'Failed to complete counter registration' });
    }
  }
);

// Get registrations list (authorized view with filters)
app.get(
  '/api/registrations',
  requireAuth(['receptionist', 'admin']),
  (req: Request, res: Response) => {
    const { date, departmentId, doctorId, status, type, search } = req.query;
    const list = db.getRegistrations({
      date: date as string,
      departmentId: departmentId as string,
      doctorId: doctorId as string,
      status: status as any,
      type: type as any,
      search: search as string,
    });
    res.json(list);
  }
);

// Public Live Queue Board (shows token and doctor room without exposing private phone numbers or addresses)
app.get('/api/live-queue', (req: Request, res: Response) => {
  const today = new Date().toISOString().split('T')[0];
  const list = db.getRegistrations({ date: today });
  // Scrub private fields for public waiting hall monitor
  const publicQueue = list.map((r) => ({
    opNumber: r.opNumber,
    tokenNumber: r.tokenNumber,
    patientInitials: r.patientName.replace(/([a-zA-Z])[a-zA-Z]+/g, '$1.***'),
    doctorName: r.doctorName,
    departmentName: r.departmentName,
    roomNumber: r.roomNumber,
    appointmentTime: r.appointmentTime,
    status: r.status,
    arrivedAt: r.arrivedAt,
  }));
  res.json(publicQueue);
});

// Update patient status in queue (Registered -> Waiting -> In Consultation -> Completed / Cancelled)
app.patch(
  '/api/registrations/:id/status',
  requireAuth(['receptionist', 'admin']),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['Registered', 'Waiting', 'In Consultation', 'Completed', 'Cancelled'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const updated = await db.updateRegistrationStatus(id, status);
    if (!updated) {
      res.status(404).json({ error: 'Registration record not found' });
      return;
    }

    res.json({
      success: true,
      registration: updated,
    });
  }
);

// Admin Dashboard KPI Stats
app.get(
  '/api/dashboard/stats',
  requireAuth(['admin', 'receptionist']),
  (req: Request, res: Response) => {
    res.json(db.getDashboardStats());
  }
);

// Admin Doctor Management: Add Doctor
app.post(
  '/api/admin/doctors',
  requireAuth(['admin']),
  (req: Request, res: Response) => {
    const {
      name,
      qualification,
      departmentId,
      specialization,
      experienceYears,
      roomNumber,
      floor,
      consultationFee,
      opdDays,
      opdTimings,
    } = req.body;

    const dept = db.getDepartments().find((d) => d.id === departmentId);
    if (!dept) {
      res.status(400).json({ error: 'Invalid department' });
      return;
    }

    const defaultSlots = [
      '09:00 AM',
      '09:30 AM',
      '10:00 AM',
      '10:30 AM',
      '11:00 AM',
      '11:30 AM',
      '12:00 PM',
      '02:00 PM',
      '02:30 PM',
      '03:00 PM',
      '03:30 PM',
      '04:00 PM',
    ];

    const newDoc = db.addDoctor({
      name,
      qualification,
      departmentId,
      departmentName: dept.name,
      specialization,
      experienceYears: parseInt(experienceYears, 10) || 5,
      roomNumber,
      floor,
      consultationFee: parseInt(consultationFee, 10) || 400,
      opdDays: opdDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      opdTimings: opdTimings || '09:00 AM - 01:00 PM | 03:00 PM - 05:00 PM',
      availableSlots: defaultSlots,
      isAvailable: true,
    });

    res.status(201).json({ success: true, doctor: newDoc });
  }
);

// Admin Doctor Management: Toggle availability or edit doctor
app.patch(
  '/api/admin/doctors/:id',
  requireAuth(['admin']),
  (req: Request, res: Response) => {
    const { id } = req.params;
    const updated = db.updateDoctor(id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }
    res.json({ success: true, doctor: updated });
  }
);

// Admin Doctor Management: Delete doctor
app.delete(
  '/api/admin/doctors/:id',
  requireAuth(['admin']),
  (req: Request, res: Response) => {
    const { id } = req.params;
    const ok = db.deleteDoctor(id);
    if (!ok) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }
    res.json({ success: true, message: 'Doctor deleted' });
  }
);

// Admin Department Management: Add department
app.post(
  '/api/admin/departments',
  requireAuth(['admin']),
  (req: Request, res: Response) => {
    const { name, code, description, floor, wing, headDoctor, iconName } = req.body;
    if (!name || !code) {
      res.status(400).json({ error: 'Department name and code are required' });
      return;
    }
    const newDept = db.addDepartment({
      name,
      code,
      description: description || 'Specialized outpatient clinical care',
      floor: floor || '1st Floor',
      wing: wing || 'Clinical Wing',
      headDoctor: headDoctor || 'Senior Consultant',
      iconName: iconName || 'Stethoscope',
      active: true,
    });
    res.status(201).json({ success: true, department: newDept });
  }
);

// Admin Department Management: Update department
app.patch(
  '/api/admin/departments/:id',
  requireAuth(['admin']),
  (req: Request, res: Response) => {
    const { id } = req.params;
    const updated = db.updateDepartment(id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Department not found' });
      return;
    }
    res.json({ success: true, department: updated });
  }
);

// Admin Department Management: Delete department
app.delete(
  '/api/admin/departments/:id',
  requireAuth(['admin']),
  (req: Request, res: Response) => {
    const { id } = req.params;
    const ok = db.deleteDepartment(id);
    if (!ok) {
      res.status(404).json({ error: 'Department not found' });
      return;
    }
    res.json({ success: true, message: 'Department deleted' });
  }
);

// Reset demo data helper
app.post(
  '/api/admin/reset-demo',
  requireAuth(['admin']),
  (req: Request, res: Response) => {
    db.resetDemoData();
    res.json({ success: true, message: 'Demo data has been reset to default state.' });
  }
);

// ---------------- VITE FRONTEND INTEGRATION ----------------

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CareConnect Hospital OP Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
