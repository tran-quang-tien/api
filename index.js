import express from 'express';
import sql from 'mssql';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import twilio from 'twilio';
import axios from 'axios';
import nodemailer from 'nodemailer';
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/images', express.static(path.join(process.cwd(), 'public/images')));
// CẤU HÌNH DATABASE
const config = {
    user: 'sa',
    password: '123',
    server: '127.0.0.1',
    port: 1433,
    database: 'sakura_cafe',
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};
const PORT = process.env.PORT || 3003;
const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('Kết nối SQL Server thành công!');
        return pool;
    })
    .catch(err => console.log('Lỗi kết nối SQL Server: ', err));
const pool = await sql.connect(config);
// Cấu hình hòm mail gửi đi (Dùng Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'yaboku209@gmail.com', 
        pass: 'zuzh nypq gmqv gevt'        
    }
})
// UPLOAD ẢNH CHAT
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'public/images';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // Giữ tên gốc hoặc đặt tên theo thời gian để tránh trùng
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });
//  API ĐĂNG NHẬP
app.post('/api/login', async (req, res) => {
    try {
        const { account, password } = req.body; 
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('account', sql.NVarChar, account)
            .input('password', sql.NVarChar, password)
            .query(`
                SELECT user_id, full_name, email, phone, address, role_id, avatar 
                FROM users 
                WHERE (email = @account OR phone = @account) 
                AND password = @password
            `);

        if (result.recordset.length > 0) {
            const user = result.recordset[0];
            res.json({
                success: true,
                user: { 
                    id: user.user_id, 
                    name: user.full_name, 
                    email: user.email,     
                    phone: user.phone,     
                    address: user.address, 
                    role_id: user.role_id,
                    avatar: user.avatar 
                }
            });
        } else {
            res.status(401).json({ 
                success: false, 
                message: "Thông tin tài khoản hoặc mật khẩu không chính xác" 
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// Đăng kí với xác minh otp firebase
app.post('/api/register/check-exists', async (req, res) => {
    try {
        const { phone, email } = req.body;
        let pool = await sql.connect(config);
        const checkResult = await pool.request()
            .input('phone', sql.VarChar, phone)
            .input('email', sql.NVarChar, email)
            .query("SELECT user_id FROM users WHERE phone = @phone OR email = @email");

        if (checkResult.recordset.length > 0) {
            return res.status(400).json({ success: false, message: "Số điện thoại hoặc Email đã tồn tại!" });
        }

        res.json({ success: true, message: "Hợp lệ" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
app.post('/api/register/complete', async (req, res) => {
    try {
        const { full_name, email, password, phone, address } = req.body;
        let pool = await sql.connect(config);
        
        await pool.request()
            .input('name', sql.NVarChar, full_name)
            .input('email', sql.NVarChar, email)
            .input('pass', sql.NVarChar, password)
            .input('phone', sql.VarChar, phone)
            .input('addr', sql.NVarChar, address)
            .query(`
                INSERT INTO users (full_name, email, password, phone, address, role_id, is_verified, created_at)
                VALUES (@name, @email, @pass, @phone, @addr, 3, 1, GETDATE())
            `);

        res.json({ success: true, message: "Đăng ký tài khoản thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// Đăng kí xác minh với node base
// Biến tạm lưu OTP Email (Trong thực tế nên lưu vào Redis hoặc Database có TTL)
let emailOtpStore = {}; 
// API 1: Gửi OTP qua Email
app.post('/api/register/send-email-otp', async (req, res) => {
    try {
        const { email } = req.body;
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        emailOtpStore[email] = {
            otp: otp,
            expires: Date.now() + 5 * 60 * 1000 // Hết hạn sau 5 phút
        };

        await transporter.sendMail({
            from: 'Sakura Cafe 🌸 <yaboku209@gmail.com>',
            to: email,
            subject: 'Mã xác thực đăng ký',
            html: `<h3>Mã OTP của bạn là: <b style="color:red; font-size:24px;">${otp}</b></h3>`
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Không thể gửi mail!" });
    }
});

// API 2: Xác thực mã OTP Email
app.post('/api/register/verify-email-otp', (req, res) => {
    const { email, otp } = req.body;
    const data = emailOtpStore[email];

    if (data && data.otp === otp && data.expires > Date.now()) {
        delete emailOtpStore[email]; 
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: "Mã OTP sai hoặc hết hạn!" });
    }
});

// API 3: Hoàn tất đăng ký (Lưu vào SQL)
    app.post('/api/register/complete', async (req, res) => {
        try {
            const { full_name, email, password, phone, address } = req.body;
            let pool = await sql.connect(config);
            await pool.request()
                .input('name', sql.NVarChar, full_name)
                .input('email', sql.NVarChar, email)
                .input('pass', sql.NVarChar, password)
                .input('phone', sql.VarChar, phone)
                .input('addr', sql.NVarChar, address)
                .query(`INSERT INTO users (full_name, email, password, phone, address, role_id, is_verified, created_at)
                        VALUES (@name, @email, @pass, @phone, @addr, 3, 1, GETDATE())`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
// Đổi mk
// API 1: Gửi mail khôi phục (Giữ nguyên hoặc cập nhật resetLink nếu cần)
// Biến tạm để lưu OTP (Trong thực tế nên lưu vào Redis hoặc DB có thời gian hết hạn)
let otpStore = {}; 

// API 1: GỬI OTP VỀ EMAIL
app.post('/api/send-email-otp', async (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // Tạo mã 6 số
    otpStore[email] = otp; // Lưu lại để tí kiểm tra

    const mailOptions = {
        from: '"Sakura Café" <yaboku209@gmail.com>',
        to: email,
        subject: '🌸 MÃ XÁC MINH OTP SAKURA',
        html: `<h3>Mã OTP của bạn là: <b style="color: #d81b60; font-size: 24px;">${otp}</b></h3>
               <p>Mã này có hiệu lực trong 5 phút. Vui lòng không chia sẻ cho bất kỳ ai!</p>`
    };

    try {
        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: "OTP đã gửi về Email!" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Lỗi gửi mail" });
    }
});

// API 2: XÁC MINH OTP EMAIL
app.post('/api/verify-email-otp', (req, res) => {
    const { email, otp } = req.body;
    if (otpStore[email] === otp) {
        delete otpStore[email]; // Xác minh xong thì xóa mã
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: "Mã OTP không chính xác!" });
    }
});

// API 3: CẬP NHẬT MẬT KHẨU (MSSQL)
app.post('/api/reset-password-db', async (req, res) => {
    const { email, phone, newPassword } = req.body;
    try {
        let pool = await sql.connect(config);
        let request = pool.request();
        request.input('newPass', sql.NVarChar, newPassword);
        
        let query = email 
            ? "UPDATE users SET password = @newPass WHERE email = @target" 
            : "UPDATE users SET password = @newPass WHERE phone = @target";
        
        request.input('target', sql.NVarChar, email || phone.replace("+84", "0"));
        await request.query(query);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});
//email tuyển dụng
app.post('/api/send-recruitment', async (req, res) => {
    const { name, phone, position, shift, experience, note } = req.body;

    const mailOptions = {
    from: '"Sakura Café Tuyển Dụng" <email-cua-ban@gmail.com>', 
    to: 'yaboku209@gmail.com', 
    subject: `🌸 ĐƠN ỨNG TUYỂN MỚI: [${position}] - ${name}`,
    html: `
        <div style="font-family: Arial, sans-serif; border: 1px solid #d81b60; padding: 20px; border-radius: 10px;">
            <h2 style="color: #d81b60;">Hồ Sơ Ứng Tuyển Mới</h2>
            <p><b>Họ và tên:</b> ${name}</p>
            <p><b>Số điện thoại:</b> ${phone}</p>
            <p><b>Vị trí ứng tuyển:</b> <span style="color: #d81b60; font-weight: bold;">${position}</span></p>
            <p><b>Ca làm việc:</b> ${shift}</p>
            <p><b>Kinh nghiệm:</b> ${experience || 'Chưa có'}</p>
            <hr />
            <p><b>Lời nhắn thêm:</b> ${note || 'Không có'}</p>
        </div>
    `
};

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ success: true, message: 'Gửi mail thành công!' });
    } catch (error) {
        console.error("Lỗi gửi mail:", error);
        res.status(500).json({ success: false, message: 'Lỗi server khi gửi mail' });
    }
});
// riêng cho avt
app.put('/api/users/:id', upload.single('avatar'), async (req, res) => {
    const userId = req.params.id;
    const { full_name, phone, address } = req.body;
    let avatarPath = null;

    if (req.file) {
        // Lưu đường dẫn chuẩn để Header dễ đọc
        avatarPath = `/images/${req.file.filename}`;
    }

    try {
        let pool = await sql.connect(config);
        let query = `UPDATE users SET full_name = @full_name, phone = @phone, address = @address`;
        if (avatarPath) query += `, avatar = @avatar`;
        query += ` WHERE user_id = @id`;

        let request = pool.request()
            .input('id', sql.Int, userId)
            .input('full_name', sql.NVarChar, full_name)
            .input('phone', sql.VarChar, phone)
            .input('address', sql.NVarChar, address);
        
        if (avatarPath) request.input('avatar', sql.VarChar, avatarPath);

        await request.query(query);

        // Trả về avatarPath để Frontend cập nhật session
        res.json({ 
            success: true, 
            message: "Cập nhật thành công!",
            avatarPath: avatarPath // Trả về để update Header
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//người dùng admin
app.get('/api/users', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT user_id, full_name, email, phone, address, avatar, role_id, created_at 
            FROM users
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.put('/api/users/:id', upload.single('avatar'), async (req, res) => {
    const userId = req.params.id;
    const { full_name, phone, address } = req.body;
    let avatarPath = null;
    if (req.file) {
        avatarPath = `/images/avatars/${req.file.filename}`;
    }
    try {
        let pool = await sql.connect(config);
        let query = `UPDATE users SET full_name = @full_name, phone = @phone, address = @address`;
        if (avatarPath) query += `, avatar = @avatar`;
        query += ` WHERE user_id = @id`;

        let request = pool.request()
            .input('id', sql.Int, userId)
            .input('full_name', sql.NVarChar, full_name)
            .input('phone', sql.VarChar, phone)
            .input('address', sql.NVarChar, address);
        
        if (avatarPath) request.input('avatar', sql.VarChar, avatarPath);

        await request.query(query);
        res.json({ success: true, message: "Cập nhật thành công!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// . API XÓA NGƯỜI DÙNG (DELETE)
app.delete('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        let pool = await sql.connect(config);
        console.log(`Đang xóa user ${id} với lý do: ${reason}`);

        await pool.request()
            .input('id', sql.Int, id)
            .query("DELETE FROM users WHERE user_id = @id");
            
        res.json({ success: true, message: "Đã xóa người dùng thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// . API THAY ĐỔI TRẠNG THÁI (KHÓA/MỞ KHÓA)
app.put('/api/users/status/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { role_id, reason } = req.body; // reason được gửi từ confirmModal.reason

        let pool = await sql.connect(config);
        
        // 1. Lấy thông tin email người dùng trước
        const userRes = await pool.request()
            .input('id', sql.Int, id)
            .query("SELECT email, full_name FROM users WHERE user_id = @id");
        
        const user = userRes.recordset[0];
        if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy người dùng" });

        // 2. Cập nhật trạng thái trong DB
        await pool.request()
            .input('id', sql.Int, id)
            .input('role', sql.Int, role_id)
            .query("UPDATE users SET role_id = @role WHERE user_id = @id");

        // 3. Gửi Email thông báo
        const isLock = role_id === 0; // role_id = 0 là khóa
        const mailOptions = {
            from: 'Sakura Cafe <email_cua_ong@gmail.com>',
            to: user.email,
            subject: isLock ? 'Thông báo Khóa tài khoản' : 'Thông báo Mở khóa tài khoản',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e1e1e1;">
                    <h2 style="color: ${isLock ? '#d9534f' : '#5cb85c'};">
                        ${isLock ? 'Tài khoản của bạn đã bị khóa' : 'Tài khoản của bạn đã được mở khóa'}
                    </h2>
                    <p>Xin chào <b>${user.full_name}</b>,</p>
                    <p>Chúng tôi thông báo rằng tài khoản của bạn trên hệ thống Sakura Cafe đã thay đổi trạng thái.</p>
                    <p><b>Lý do:</b> ${reason || 'Không có lý do cụ thể'}</p>
                    <hr>
                    <p>Nếu có bất kỳ thắc mắc nào, vui lòng liên hệ bộ phận hỗ trợ.</p>
                </div>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) console.log("Lỗi gửi mail:", error);
            else console.log("Đã gửi mail tới: " + user.email);
        });

        res.json({ success: true, message: "Cập nhật và gửi mail thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// . API SỬA THÔNG TIN NGƯỜI DÙNG (DÀNH CHO ADMIN)
app.put('/api/users/update/:id', upload.single('avatar'), async (req, res) => {
    try {
        const { id } = req.params;
        // Bây giờ req.body sẽ có dữ liệu nhờ multer giải mã FormData
        const { full_name, phone, address } = req.body;
        
        // Kiểm tra nếu có file mới thì lấy đường dẫn, nếu không thì để null
        const avatarPath = req.file ? `/images/${req.file.filename}` : null;

        let pool = await sql.connect(config);
        
        // Tạo câu lệnh SQL động: chỉ cập nhật avatar nếu có file mới
        let query = `
            UPDATE users 
            SET full_name = @name, 
                phone = @phone, 
                address = @address
        `;
        
        const request = pool.request()
            .input('id', sql.Int, id)
            .input('name', sql.NVarChar, full_name)
            .input('phone', sql.VarChar, phone)
            .input('address', sql.NVarChar, address);

        if (avatarPath) {
            query += `, avatar = @avatar`;
            request.input('avatar', sql.NVarChar, avatarPath);
        }

        query += ` WHERE user_id = @id`;

        await request.query(query);

        res.json({ success: true, message: "Cập nhật thông tin thành công!" });
    } catch (err) {
        console.error("Lỗi cập nhật:", err.message);
        res.status(500).json({ success: false, message: "Lỗi Server: " + err.message });
    }
});
//Danh mục
//  1. Lấy danh sách DANH MỤC (Để hiện menu trái hoặc filter)
app.get('/api/categories', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request().query("SELECT * FROM categories");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//  2. Lấy danh sách SẢN PHẨM 
app.get('/api/products', async (req, res) => {
    try {
        const pool = await poolPromise; 
        const result = await pool.request().query(`
            SELECT 
                p.*, 
                c.category_name,
                ISNULL(p.discount, 0) as discount 
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.category_id
            WHERE p.is_active = 1 OR p.is_active IS NULL 
            ORDER BY p.product_id DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// QUẢN LÝ SẢN PHẨM (PRODUCTS)
// 1. Lấy danh sách sản phẩm
app.get('/api/products', async (req, res) => {
    try {
        const { status } = req.query; // Nhận 'active' hoặc 'locked' từ frontend
        let pool = await sql.connect(config);
        
        // Chuyển đổi trạng thái: locked -> 0, ngược lại mặc định là 1
        const activeValue = status === 'locked' ? 0 : 1;

        let result = await pool.request()
            .input('activeStatus', sql.Int, activeValue)
            .query(`
                SELECT
                    p.product_id, p.name, p.price, p.image, p.description,
                    p.category_id, p.discount AS product_discount,   
                    c.category_name
                FROM PRODUCTS p
                LEFT JOIN categories c ON p.category_id = c.category_id
                WHERE p.is_active = @activeStatus
                ORDER BY p.product_id DESC
            `);

        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 2. Thêm sản phẩm mới (Khớp với addProduct)
app.post('/api/products', upload.single('image'), async (req, res) => {
    try {
        // Thêm discount vào phần lấy dữ liệu từ body
        const { name, price, category_id, description, discount } = req.body;
        const imagePath = req.file ? `/images/${req.file.filename}` : null;

        let pool = await sql.connect(config);
        await pool.request()
            .input('name', sql.NVarChar, name)
            .input('price', sql.Decimal(18, 2), parseFloat(price))
            .input('category_id', sql.Int, parseInt(category_id))
            .input('desc', sql.NVarChar, description)
            .input('img', sql.NVarChar, imagePath)
            // Thêm input cho discount
            .input('discount', sql.Decimal(18, 2), discount ? parseFloat(discount) : null)
            .query(`
                INSERT INTO PRODUCTS (name, price, category_id, description, image, discount) 
                VALUES (@name, @price, @category_id, @desc, @img, @discount)
            `);
        
        res.json({ success: true, message: "Thêm sản phẩm thành công!" });
    } catch (err) {
        console.error("Lỗi thêm mới:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// 3. Cập nhật sản phẩm (Khớp với updateProduct)
app.put('/api/products/:id', upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        // Thêm discount vào phần bóc tách dữ liệu
        const { name, price, category_id, description, discount } = req.body; 
        
        let imagePath = req.body.image; 
        if (req.file) {
            imagePath = `/images/${req.file.filename}`;
        }

        let pool = await sql.connect(config);
        await pool.request()
            .input('id', sql.Int, parseInt(id))
            .input('name', sql.NVarChar, name)
            .input('price', sql.Decimal(18, 2), parseFloat(price))
            .input('category_id', sql.Int, parseInt(category_id)) 
            .input('desc', sql.NVarChar, description)
            .input('img', sql.NVarChar, imagePath)
            // Thêm input cho discount, nếu không có thì gửi null
            .input('discount', sql.Decimal(18, 2), discount ? parseFloat(discount) : null)
            .query(`
                UPDATE PRODUCTS 
                SET name = @name, 
                    price = @price, 
                    category_id = @category_id,
                    description = @desc, 
                    image = @img,
                    discount = @discount
                WHERE product_id = @id
            `);
        
        res.json({ success: true });
    } catch (err) {
        console.error("Lỗi cập nhật:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// 4. khóa sản phẩm 
app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query("UPDATE products SET is_active = 0 WHERE product_id = @id");

        if (result.rowsAffected[0] > 0) {
            res.json({ success: true, message: "Đã khóa món thành công (Ẩn khỏi thực đơn)!" });
        } else {
            res.status(404).json({ success: false, message: "Không tìm thấy món!" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// 5. mở khóa sản phẩm
app.put('/api/products/:id/unlock', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        
        await pool.request()
            .input('id', sql.Int, id)
            .query("UPDATE PRODUCTS SET is_active = 1 WHERE product_id = @id");

        res.json({ success: true, message: "Đã mở khóa sản phẩm!" });
    } catch (err) {
        console.error("Lỗi mở khóa:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// 6.hiển thị món đã khóa
app.get('/api/products/locked', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request().query(`
            SELECT
                p.product_id, p.name, p.price, p.image, p.description,
                p.category_id, p.discount AS product_discount,   
                c.category_name
            FROM PRODUCTS p
            LEFT JOIN categories c ON p.category_id = c.category_id
            WHERE p.is_active = 0
            ORDER BY p.product_id DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//bán mang về
app.post('/api/checkout', async (req, res) => {
    const { 
        user_id, customer_name, customer_phone, 
        shipping_address, total_amount, payment_method, 
        note, cartItems 
    } = req.body;

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ success: false, error: "Giỏ hàng trống!" });
    }

    try {
        const pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // --- BƯỚC 1: LẤY THÔNG TIN KHÁCH HÀNG (Giữ nguyên của ông) ---
            let finalName = customer_name;
            let finalPhone = customer_phone;
            let finalAddress = shipping_address;

            if (user_id && (!finalName || !finalPhone || !finalAddress)) {
                const userRes = await new sql.Request(transaction)
                    .input('uid', sql.Int, user_id)
                    .query(`SELECT full_name, phone, address FROM users WHERE user_id = @uid`);
                
                if (userRes.recordset.length > 0) {
                    const u = userRes.recordset[0];
                    finalName = finalName || u.full_name;
                    finalPhone = finalPhone || u.phone;
                    finalAddress = finalAddress || u.address;
                }
            }

            // --- BƯỚC 2: INSERT VÀO BẢNG ORDERS (Giữ nguyên của ông) ---
            const orderResult = await new sql.Request(transaction)
                .input('user_id', sql.Int, user_id)
                .input('order_type', sql.NVarChar, 'Online')
                .input('total_amount', sql.Decimal(18, 2), total_amount)
                .input('payment_method', sql.NVarChar, payment_method)
                .input('status', sql.NVarChar, 'Chờ xác nhận')
                .input('note', sql.NVarChar, note || 'Khách đặt Online')
                .input('fullname', sql.NVarChar, finalName) 
                .input('phone', sql.VarChar, finalPhone)     
                .input('address', sql.NVarChar, finalAddress) 
                .query(`
                    INSERT INTO orders (user_id, order_type, total_amount, payment_method, status, note, fullname, phone, address, created_at)
                    OUTPUT INSERTED.order_id
                    VALUES (@user_id, @order_type, @total_amount, @payment_method, @status, @note, @fullname, @phone, @address, GETDATE())
                `);

            const orderId = orderResult.recordset[0].order_id;

            // --- BƯỚC 3: LƯU CHI TIẾT ĐƠN HÀNG ---
            for (const item of cartItems) {
                const productId = item.product_id || item.id;
                
                await new sql.Request(transaction)
                    .input('order_id', sql.Int, orderId)
                    .input('product_id', sql.Int, productId)
                    .input('quantity', sql.Int, item.quantity)
                    .input('price', sql.Decimal(18, 2), item.price)
                    .input('total_price', sql.Decimal(18, 2), item.price * item.quantity)
                    .query(`
                        INSERT INTO order_details (order_id, product_id, quantity, price, total_price)
                        VALUES (@order_id, @product_id, @quantity, @price, @total_price)
                    `);

                // --- BƯỚC 4: TỰ ĐỘNG TRỪ KHO BAO BÌ THEO ĐỊNH MỨC ---
                // Logic: Trừ số lượng trong bảng packaging dựa trên bảng định mức product_packaging
                await new sql.Request(transaction)
                    .input('p_id', sql.Int, productId)
                    .input('order_qty', sql.Int, item.quantity)
                    .query(`
                        UPDATE pk
                        SET pk.quantity = pk.quantity - (pp.quantity * @order_qty)
                        FROM packaging pk
                        INNER JOIN product_packaging pp ON pk.packaging_id = pp.packaging_id
                        WHERE pp.product_id = @p_id
                    `);
            }

            await transaction.commit();
            res.json({ success: true, message: "Đặt hàng thành công và đã trừ kho bao bì!", order_id: orderId });

        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error("LỖI CHECKOUT:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
// API bán tại quầy có tùy chọn mang về/tại chỗ
app.post("/api/orders/pos", async (req, res) => {
    const { items, total_amount, payment_method, order_type } = req.body; 
    // order_type sẽ nhận giá trị: N'Tại chỗ' hoặc N'Mang về'

    try {
        const pool = await poolPromise;
        const transaction = new sql.Transaction(pool);
        await transaction.begin(); // Bắt đầu giao dịch

        try {
            // --- BƯỚC 1: LƯU VÀO BẢNG orders ---
            const orderResult = await new sql.Request(transaction)
                .input('total_amount', sql.Decimal(18, 2), total_amount)
                .input('payment_method', sql.NVarChar, payment_method)
                .input('order_type', sql.NVarChar, order_type)
                .query(`
                    INSERT INTO orders (user_id, order_type, total_amount, payment_method, status, created_at)
                    OUTPUT inserted.order_id
                    VALUES (NULL, @order_type, @total_amount, @payment_method, N'Đã hoàn thành', GETDATE())
                `);

            const orderId = orderResult.recordset[0].order_id;

            // --- BƯỚC 2: LƯU CHI TIẾT VÀ TRỪ BAO BÌ ---
            if (items && items.length > 0) {
                for (const item of items) {
                    // Lưu chi tiết đơn hàng
                    await new sql.Request(transaction)
                        .input('order_id', sql.Int, orderId)
                        .input('product_id', sql.Int, item.product_id)
                        .input('quantity', sql.Int, item.qty)
                        .input('price', sql.Decimal(18, 2), item.sellPrice)
                        .input('total_price', sql.Decimal(18, 2), item.sellPrice * item.qty)
                        .query(`
                            INSERT INTO order_details (order_id, product_id, quantity, price, total_price)
                            VALUES (@order_id, @product_id, @quantity, @price, @total_price)
                        `);

                    // --- BƯỚC 3: NẾU LÀ MANG VỀ THÌ TRỪ KHO BAO BÌ ---
                    if (order_type === 'Mang về') {
                        await new sql.Request(transaction)
                            .input('p_id', sql.Int, item.product_id)
                            .input('order_qty', sql.Int, item.qty)
                            .query(`
                                UPDATE pk
                                SET pk.quantity = pk.quantity - (pp.quantity * @order_qty)
                                FROM packaging pk
                                INNER JOIN product_packaging pp ON pk.packaging_id = pp.packaging_id
                                WHERE pp.product_id = @p_id
                            `);
                    }
                }
            }

            await transaction.commit(); // Hoàn tất mọi thay đổi
            res.status(200).json({ success: true, orderId });

        } catch (err) {
            await transaction.rollback(); // Nếu lỗi thì hủy hết các bước trên
            throw err;
        }
    } catch (err) {
        console.error("Lỗi POS:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
//NGUYÊN LIỆU – NHẬP KHO
//  Lấy danh sách nguyên liệu (STAFF nhập kho)
app.get('/api/staff/purchase-history', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request().query(`
            SELECT purchase_id, supplier_name, supplier_phone, total_amount, created_at 
            FROM purchase_orders 
            ORDER BY created_at DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/staff/purchase-orders/:id/details', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query(`
                SELECT 
                    d.quantity, 
                    d.import_price, 
                    d.total_price, 
                    i.name AS ingredient_name,
                    i.unit
                FROM purchase_order_details d
                JOIN ingredients i ON d.product_id = i.ingredient_id
                WHERE d.purchase_id = @id
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//  Thêm nguyên liệu mới
app.post('/api/staff/ingredients/new', async (req, res) => {
    const { name, unit } = req.body;
    try {
        // Sử dụng OUTPUT INSERTED để lấy thông tin vừa tạo
        const result = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('unit', sql.NVarChar, unit)
            .query(`
                INSERT INTO INGREDIENTS (name, unit, quantity, supplier, import_price)
                OUTPUT INSERTED.ingredient_id, INSERTED.name, INSERTED.unit, INSERTED.import_price
                VALUES (@name, @unit, 0, N'Không xác định', 0)
            `);
        
        // Trả về object nguyên liệu vừa tạo thay vì chỉ {success: true}
        res.json(result.recordset[0]); 
    } catch (err) {
        console.error("Lỗi tạo nguyên liệu:", err);
        res.status(500).json({ error: err.message });
    }
});

//  Cập nhật giá nhập nguyên liệu
app.put('/api/ingredients/:id/price', async (req, res) => {
    const { id } = req.params;
    const { import_price } = req.body;
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .input('price', sql.Decimal(18, 2), import_price)
            .query(`
                UPDATE INGREDIENTS
                SET import_price = @price
                WHERE ingredient_id = @id
            `);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// STAFF – PHIẾU NHẬP KHO (PURCHASE ORDERS)
//  Danh sách phiếu nhập
app.post('/api/staff/purchase-orders', async (req, res) => {
    const { supplier_name, total_amount, note, details } = req.body;
    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        // 1. Chèn vào bảng purchase_orders
        const orderRes = await transaction.request()
            .input('supplier', sql.NVarChar, supplier_name)
            .input('total', sql.Decimal(18, 2), total_amount)
            .input('note', sql.NVarChar, note)
            .query(`
                INSERT INTO purchase_orders (supplier_name, total_amount, note, created_at)
                OUTPUT INSERTED.purchase_id
                VALUES (@supplier, @total, @note, GETDATE())
            `);

        const purchaseId = orderRes.recordset[0].purchase_id;

        // 2. Lặp qua từng nguyên liệu trong details để lưu chi tiết và cập nhật kho
        for (const item of details) {
            // Lưu chi tiết phiếu nhập
            await transaction.request()
                .input('pid', sql.Int, purchaseId)
                .input('iid', sql.Int, item.ingredient_id)
                .input('qty', sql.Float, item.qty)
                .input('price', sql.Decimal(18, 2), item.import_price)
                .query(`
                    INSERT INTO purchase_order_details (purchase_id, product_id, quantity, import_price)
                    VALUES (@pid, @iid, @qty, @price)
                `);

            // CẬP NHẬT GIÁ NHẬP & SỐ LƯỢNG MỚI VÀO BẢNG INGREDIENTS
            await transaction.request()
                .input('iid', sql.Int, item.ingredient_id)
                .input('qty', sql.Float, item.qty)
                .input('price', sql.Decimal(18, 2), item.import_price)
                .query(`
                    UPDATE INGREDIENTS
                    SET quantity = quantity + @qty,
                        import_price = @price
                    WHERE ingredient_id = @iid
                `);
        }

        await transaction.commit();
        res.json({ success: true, message: "Nhập kho và cập nhật giá thành công!" });
    } catch (err) {
        await transaction.rollback();
        console.error("Lỗi giao dịch nhập kho:", err);
        res.status(500).json({ error: err.message });
    }
});


// ONLINE ORDER – ĐƠN HÀNG ONLINE (CUSTOMER
// 1. Lấy danh sách đơn hàng đang chờ (Khớp với đường dẫn Frontend đang gọi)
app.get('/api/admin/orders/pending', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request().query(`
            SELECT order_id, user_id, total_amount, note, created_at, fullname, phone, address
            FROM dbo.orders
            WHERE status = N'Chờ xác nhận'
            ORDER BY created_at DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error("Lỗi API pending:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. Lấy chi tiết đơn hàng
app.get('/api/admin/orders/:id/details', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('oid', sql.Int, id)
            .query(`
                SELECT od.*, p.name as product_name 
                FROM dbo.order_details od
                JOIN dbo.products p ON od.product_id = p.product_id
                WHERE od.order_id = @oid
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error("Lỗi API details:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. Cập nhật trạng thái "Hoàn thành" 
app.put('/api/admin/orders/:id/complete', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        await pool.request()
            .input('oid', sql.Int, id)
            .query(`UPDATE dbo.orders SET status = N'Đã hoàn thành' WHERE order_id = @oid`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//lịch sử đơn 
app.get('/api/admin/orders-history', async (req, res) => {
    try {
        const { type, startDate, endDate } = req.query;
        let pool = await sql.connect(config);

        // Lấy ngày đầu tiên và cuối cùng của tháng hiện tại để reset doanh thu tự động
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

        let query = `
            SELECT 
                order_id, 
                fullname as display_name, -- Lấy trực tiếp từ bảng orders
                phone as display_phone, 
                address as display_address,
                order_type, total_amount, status, created_at, note
            FROM orders 
            WHERE 1=1
        `;
        if (!startDate && !endDate) {
            query += ` AND created_at >= '${firstDayOfMonth}' AND created_at <= '${lastDayOfMonth}'`;
        }

        if (type && type !== 'All') query += ` AND order_type = N'${type}'`;
        if (startDate) query += ` AND created_at >= '${startDate}'`;
        if (endDate) query += ` AND created_at <= '${endDate}'`;

        query += ` ORDER BY created_at DESC`;

        const result = await pool.request().query(query);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//Bookings
// 1. Lấy toàn bộ danh sách đặt bàn (Sắp xếp mới nhất lên đầu)
app.get('/api/bookings', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request()
            .query("SELECT * FROM dbo.bookings ORDER BY created_at DESC");
        res.json(result.recordset);
    } catch (err) {
        console.error("Lỗi lấy danh sách:", err.message);
        res.status(500).json({ error: "Lỗi Server" });
    }
});

// 2. Cập nhật trạng thái (Duyệt/Hủy/Khôi phục)
app.put('/api/bookings/:id/status', async (req, res) => {
    try {
        const { status, cancelReason } = req.body; 
        const { id } = req.params;

        let pool = await sql.connect(config);
        

        const infoQuery = await pool.request()
            .input('id', sql.Int, id)
            .query("SELECT email, customer_name, booking_date, booking_time FROM dbo.bookings WHERE booking_id = @id");
        
        const booking = infoQuery.recordset[0];
        if (!booking || !booking.email) throw new Error("Không tìm thấy email khách hàng");


        await pool.request()
            .input('id', sql.Int, id)
            .input('status', sql.NVarChar, status)
            .query("UPDATE dbo.bookings SET status = @status WHERE booking_id = @id");

 
        const isConfirmed = status === "Đã xác nhận";
        const mailOptions = {
            from: '"Sakura Café 🌸" <email_cua_ong@gmail.com>',
            to: booking.email,
            subject: isConfirmed ? "Xác Nhận Đặt Bàn Thành Công" : "Thông Báo Hủy Đơn Đặt Bàn",
            html: `
                <div style="font-family: Arial, sans-serif; border: 1px solid #ffb7c5; padding: 20px;">
                    <h2 style="color: #d85a7f;">${isConfirmed ? "🌸 Cảm ơn bạn đã đặt bàn!" : "📢 Thông báo về đơn đặt bàn"}</h2>
                    <p>Chào <strong>${booking.customer_name}</strong>,</p>
                    <p>Đơn hàng <strong>#${id}</strong> của bạn đã được chuyển sang trạng thái: <strong>${status}</strong>.</p>
                    <hr>
                    <p>📅 Ngày: ${new Date(booking.booking_date).toLocaleDateString('vi-VN')}</p>
                    <p>⏰ Giờ: ${booking.booking_time}</p>
                    ${!isConfirmed ? `<p style="color: red;"><strong>Lý do hủy:</strong> ${cancelReason || "Nhà hàng có việc đột xuất"}</p>` : `<p>Hẹn gặp bạn tại cửa hàng nhé!</p>`}
                    <hr>
                    <p style="font-size: 12px; color: #888;">Đây là mail tự động, vui lòng không trả lời.</p>
                </div>
            `
        };


        await transporter.sendMail(mailOptions);

        res.json({ success: true, message: `Đã cập nhật ${status} và gửi mail!` });
    } catch (err) {
        console.error("Lỗi:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. Xóa vĩnh viễn đơn hàng
app.delete('/api/bookings/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        await pool.request()
            .input('id', sql.Int, id)
            .query("DELETE FROM dbo.bookings WHERE booking_id = @id");
        res.json({ success: true, message: "Đã xóa vĩnh viễn" });
    } catch (err) {
        res.status(500).json({ error: "Lỗi khi xóa dữ liệu" });
    }
});
app.post('/api/bookings', async (req, res) => {
    try {
        const { user_id, customer_name, phone, email, booking_date, booking_time, number_of_people, note } = req.body;
        let pool = await sql.connect(config);

        await pool.request()
            .input('uid', sql.Int, user_id || null)
            .input('name', sql.NVarChar, customer_name)
            .input('phone', sql.VarChar, phone)
            .input('email', sql.NVarChar, email)
            .input('date', sql.Date, booking_date)
            .input('time', sql.VarChar, booking_time)
            .input('people', sql.Int, number_of_people)
            .input('note', sql.NVarChar, note)
            .query(`
                INSERT INTO bookings (user_id, customer_name, phone, email, booking_date, booking_time, number_of_people, note, status, created_at)
                VALUES (@uid, @name, @phone, @email, @date, @time, @people, @note, N'Chờ xác nhận', GETDATE())
            `);

        res.json({ success: true, message: "Đặt bàn thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// API cập nhật trạng thái (Dùng cho hàm updateBookingStatus ở Frontend)
app.put('/api/bookings/:id', async (req, res) => {
    try {
        const { status, reason } = req.body;
        let pool = await sql.connect(config);
        await pool.request()
            .input('id', sql.Int, req.params.id)
            .input('status', sql.NVarChar, status)
            .query("UPDATE booking SET status = @status WHERE booking_id = @id");
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//thống kê
//ngày
app.get('/api/admin/revenue/daily', async (req, res) => {
    try {
        const { date } = req.query; 
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('date', sql.VarChar, date)
            .query(`
                SELECT 
                    DATEPART(HOUR, created_at) as hour,
                    ISNULL(SUM(CASE WHEN order_type = 'Online' THEN total_amount ELSE 0 END), 0) as total_online,
                    ISNULL(SUM(CASE WHEN order_type = N'Trực tiếp' THEN total_amount ELSE 0 END), 0) as total_offline
                FROM dbo.orders
                WHERE CAST(created_at AS DATE) = @date
                GROUP BY DATEPART(HOUR, created_at)
                ORDER BY hour
            `);
        
        // Tạo mảng 24 giờ mặc định (từ 0h đến 23h) để biểu đồ luôn đầy đủ
        const fullDay = Array.from({ length: 24 }, (_, i) => ({
            hour: i,
            total_online: 0,
            total_offline: 0
        }));

        // Ghi đè dữ liệu thực tế vào mảng 24 giờ
        result.recordset.forEach(row => {
            fullDay[row.hour] = { 
                hour: row.hour, 
                total_online: row.total_online, 
                total_offline: row.total_offline 
            };
        });

        res.json(fullDay);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//tháng
app.get('/api/admin/revenue/monthly', async (req, res) => {
    try {
        const { startMonth, endMonth } = req.query;
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('start', sql.VarChar, `${startMonth}-01`)
            .input('end', sql.VarChar, `${endMonth}-01`)
            .query(`
                SELECT 
                    MONTH(created_at) as month, 
                    YEAR(created_at) as year,
                    -- Dùng N để hỗ trợ tiếng Việt có dấu trong SQL
                    SUM(CASE WHEN order_type = 'Online' THEN total_amount ELSE 0 END) as total_online,
                    SUM(CASE WHEN order_type = N'Trực tiếp' OR order_type = 'Offline' THEN total_amount ELSE 0 END) as total_offline
                FROM dbo.orders
                WHERE created_at >= @start AND created_at <= EOMONTH(@end)
                GROUP BY YEAR(created_at), MONTH(created_at)
                ORDER BY year, month
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//tổng hợp
app.get('/api/admin/revenue/profit-summary', async (req, res) => {
    try {
        const { start, end } = req.query;
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('start', sql.VarChar, start)
            .input('end', sql.VarChar, end)
            .query(`
                DECLARE @OnlineMoney DECIMAL(18,2), @OfflineMoney DECIMAL(18,2);
                DECLARE @OnlineCount INT, @OfflineCount INT, @ImportMoney DECIMAL(18,2);

                -- 1. Tính doanh thu từ bảng orders
                SELECT 
                    @OnlineMoney = ISNULL(SUM(CASE WHEN order_type = 'Online' THEN total_amount ELSE 0 END), 0),
                    @OfflineMoney = ISNULL(SUM(CASE WHEN order_type = N'Trực tiếp' THEN total_amount ELSE 0 END), 0),
                    @OnlineCount = COUNT(CASE WHEN order_type = 'Online' THEN order_id END),
                    @OfflineCount = COUNT(CASE WHEN order_type = N'Trực tiếp' THEN order_id END)
                FROM dbo.orders 
                WHERE FORMAT(created_at, 'yyyy-MM-dd') BETWEEN @start AND @end;

                -- 2. Tính tiền nhập hàng từ bảng purchase_orders của ông
                SELECT @ImportMoney = ISNULL(SUM(total_amount), 0) 
                FROM dbo.purchase_orders 
                WHERE FORMAT(created_at, 'yyyy-MM-dd') BETWEEN @start AND @end;

                -- 3. Trả về kết quả tổng hợp
                SELECT 
                    ISNULL(@OnlineMoney, 0) as online_money, 
                    ISNULL(@OnlineCount, 0) as online_count,
                    ISNULL(@OfflineMoney, 0) as offline_money, 
                    ISNULL(@OfflineCount, 0) as offline_count,
                    (ISNULL(@OnlineMoney, 0) + ISNULL(@OfflineMoney, 0)) as gross_revenue,
                    (ISNULL(@OnlineMoney, 0) + ISNULL(@OfflineMoney, 0)) * 0.05 as discount,
                    (ISNULL(@OnlineMoney, 0) + ISNULL(@OfflineMoney, 0)) * 0.08 as tax,
                    ISNULL(@ImportMoney, 0) as total_import,
                    ((ISNULL(@OnlineMoney, 0) + ISNULL(@OfflineMoney, 0)) 
                      - (ISNULL(@OnlineMoney, 0) + ISNULL(@OfflineMoney, 0))*0.13 
                      - ISNULL(@ImportMoney, 0)) as profit
            `);
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//  Gửi tin nhắn (có thể kèm ảnh)
app.post('/api/messages/send', upload.single('image'), async (req, res) => {
    const {
        user_id,
        customer_name,
        customer_phone,
        sender_type,
        message_text
    } = req.body;

    const image_url = req.file ? `/images/${req.file.filename}` : null;

    try {
        await pool.request()
            .input('uid', sql.Int, user_id || null)
            .input('name', sql.NVarChar, customer_name)
            .input('phone', sql.VarChar, customer_phone)
            .input('type', sql.VarChar, sender_type)
            .input('msg', sql.NVarChar, message_text || '')
            .input('img', sql.NVarChar, image_url)
            .query(`
                INSERT INTO MESSAGES
                (user_id, customer_name, customer_phone, sender_type, message_text, image_url, created_at)
                VALUES (@uid, @name, @phone, @type, @msg, @img, GETDATE())
            `);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//  Danh sách khách đã từng nhắn (sidebar staff)
app.get('/api/messages/customers', async (req, res) => {
    try {
        const result = await pool.request().query(`
            SELECT 
                customer_name, 
                customer_phone, 
                MAX(created_at) AS last_time,
                -- Đếm những tin nhắn từ khách gửi mà is_read đang NULL
                COUNT(CASE WHEN sender_type = 'customer' AND is_read IS NULL THEN 1 END) AS unread_count
            FROM MESSAGES
            GROUP BY customer_name, customer_phone
            ORDER BY last_time DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//  Lịch sử chat theo số điện thoại
app.get('/api/messages/history/:phone', async (req, res) => {
    try {
        const result = await pool.request()
            .input('phone', sql.VarChar, req.params.phone)
            .query(`
                SELECT *
                FROM MESSAGES
                WHERE customer_phone = @phone
                ORDER BY created_at ASC
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// đánh dấu dã đọc
app.put('/api/messages/mark-read/:phone', async (req, res) => {
    const { phone } = req.params;
    try {
        // Cần đảm bảo đã có pool connection từ mssql
        await pool.request()
            .input('phone', sql.VarChar, phone)
            .query(`
                UPDATE MESSAGES 
                SET is_read = 1 
                WHERE customer_phone = @phone 
                AND sender_type = 'customer' 
                AND is_read IS NULL
            `);
        res.json({ success: true });
    } catch (err) {
        console.error("Lỗi Backend mark-read:", err);
        res.status(500).json({ error: err.message });
    }
});
// người dùng
// API lấy thông tin chi tiết 1 người dùng
app.get('/api/users/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        const pool = await sql.connect(config);
        const result = await pool.request()
            .input('id', sql.Int, userId)
            .query('SELECT user_id, full_name, email, phone, address, avatar, role_id FROM users WHERE user_id = @id');

        if (result.recordset.length > 0) {
            res.json(result.recordset[0]);
        } else {
            res.status(404).json({ error: "Không tìm thấy người dùng" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
//quản lý bài viết
//1. Lấy danh sách cho khách (Sửa lỗi: Chỉ giữ 1 route và dùng đúng news_id)
app.get('/api/news/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        let result = await pool.request()
            .input('id', sql.Int, id)
            .query("SELECT * FROM news WHERE news_id = @id"); // Truy vấn theo news_id
        
        if (result.recordset.length > 0) {
            res.json(result.recordset[0]); // Trả về bài viết đầu tiên tìm thấy
        } else {
            res.status(404).json({ success: false, message: "Không tìm thấy bài viết" });
        }
    } catch (err) {
        console.error("LỖI GET DETAIL NEWS:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});
app.get('/api/news', async (req, res) => {
    try {
        let pool = await sql.connect(config); // Sử dụng config đã khai báo
        let result = await pool.request()
            .query("SELECT * FROM news ORDER BY news_id DESC"); // Đúng tên bảng 'news'
        res.json(result.recordset);
    } catch (err) {
        console.error("LỖI GET NEWS:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});
// 2. Thêm bài viết
app.post('/api/news', upload.single('image'), async (req, res) => {
    try {
        const { title, summary, content } = req.body;
        // Đảm bảo đường dẫn lưu vào DB chỉ là /images/ tên_file
        const imagePath = req.file ? `/images/${req.file.filename}` : null;

        let pool = await sql.connect(config);
        await pool.request()
            .input('title', sql.NVarChar, title)
            .input('summary', sql.NVarChar, summary)
            .input('content', sql.NVarChar, content)
            .input('image', sql.NVarChar, imagePath)
            .query("INSERT INTO news (title, summary, content, image) VALUES (@title, @summary, @content, @image)");

        res.json({ success: true, message: "Đã đăng bài thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// 3. Xóa bài viết (Sửa cột news_id cho đồng bộ)
app.delete('/api/news/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let pool = await sql.connect(config);
        await pool.request()
            .input('id', sql.Int, id)
            .query("DELETE FROM news WHERE news_id = @id");
            
        res.json({ success: true, message: "Xóa thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
app.put('/api/news/:id', upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params; // ID lấy từ URL
        const { title, summary, content } = req.body;
        let pool = await sql.connect(config);

        let query = "";
        const request = pool.request()
            .input('id', sql.Int, id)
            .input('title', sql.NVarChar, title)
            .input('summary', sql.NVarChar, summary)
            .input('content', sql.NVarChar, content);

        if (req.file) {
            // Nếu có upload ảnh mới
            const imagePath = `/images/${req.file.filename}`;
            request.input('image', sql.NVarChar, imagePath);
            query = "UPDATE news SET title = @title, summary = @summary, content = @content, image = @image WHERE news_id = @id";
        } else {
            // Nếu giữ ảnh cũ
            query = "UPDATE news SET title = @title, summary = @summary, content = @content WHERE news_id = @id";
        }

        const result = await request.query(query);

        // Kiểm tra xem có update được dòng nào không
        if (result.rowsAffected[0] > 0) {
            res.json({ success: true, message: "Cập nhật thành công!" });
        } else {
            res.status(404).json({ success: false, message: "Không tìm thấy bài viết để cập nhật" });
        }
    } catch (err) {
        console.error("LỖI UPDATE NEWS:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});
// lịch sử của khách
// 1. Lấy lịch sử mua hàng của cá nhân
app.get('/api/user/order-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        let pool = await sql.connect(config); 
        const result = await pool.request()
            .input('uid', sql.Int, userId)
            .query(`
                SELECT order_id, order_type, total_amount, payment_method, status,note, created_at
                FROM dbo.orders 
                WHERE user_id = @uid
                ORDER BY created_at DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error("Lỗi API Order History:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. API Lịch sử đặt bàn (Dựa trên email)
app.get('/api/user/booking-history/:email', async (req, res) => {
    try {
        const { email } = req.params;
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('email', sql.NVarChar, email)
            .query(`
                SELECT booking_id, customer_name, booking_date, booking_time, number_of_people, status, created_at
                FROM dbo.bookings 
                WHERE email = @email
                ORDER BY created_at DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error("Lỗi API Booking History:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
// APi xem nguyên liệu của staff và bước thực hiện món
// API 1: Lấy danh sách nguyên liệu của một món (Recipe)
app.get('/api/products/:id/recipe', async (req, res) => {
    try {
        const { id } = req.params; 
        const result = await sql.query`
            SELECT 
                i.name AS ingredient_name, 
                r.amount, 
                r.unit 
            FROM recipes r
            JOIN ingredients i ON r.ingredient_id = i.ingredient_id
            WHERE r.product_id = ${id}`; 
        
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// API 2: Lấy các bước thực hiện của một món (Processing Steps)
app.get('/api/products/:id/steps', async (req, res) => {
    try {
        const { id } = req.params;
        // SỬA Ở ĐÂY: Dùng ${id} thay vì :id
        const result = await sql.query`
            SELECT 
                step_number, 
                description 
            FROM processing_steps 
            WHERE product_id = ${id}
            ORDER BY step_number ASC`;
        
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});
//APi dữ liệu công thức và nguyên liệu món cuẩ admin
// 1. LẤY DANH SÁCH TỔNG HỢP: Sản phẩm + Nguyên liệu + Bước làm
// Thay thế hoàn toàn API recipes-list cũ bằng bản này
app.get('/api/admin/recipes-list', async (req, res) => {
  try {
    // 1. Lấy dữ liệu sản phẩm và nguyên liệu
    // Lưu ý: Tui bỏ p.description để tránh trùng với description của bước làm
    const recipesRaw = await sql.query`
      SELECT 
        p.product_id, p.name as product_name, c.category_name,
        r.recipe_id, r.ingredient_id, i.name as ingredient_name, r.amount, r.unit
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.category_id
      LEFT JOIN recipes r ON p.product_id = r.product_id
      LEFT JOIN ingredients i ON r.ingredient_id = i.ingredient_id`;

    // 2. Lấy dữ liệu bước làm - KIỂM TRA TÊN BẢNG CỦA ÔNG Ở ĐÂY
    const stepsRaw = await sql.query`
      SELECT step_id, product_id, step_number, description 
      FROM processing_steps 
      ORDER BY step_number ASC`;

    const recipes = recipesRaw.recordset;
    const steps = stepsRaw.recordset;

    // 3. Logic gộp bằng JavaScript (An toàn hơn query SQL lồng)
    const formatted = recipes.reduce((acc, current) => {
      let product = acc.find(item => item.product_id === current.product_id);
      
      const recipePart = current.recipe_id ? {
        recipe_id: current.recipe_id,
        ingredient_id: current.ingredient_id,
        ingredient_name: current.ingredient_name,
        amount: current.amount,
        unit: current.unit
      } : null;

      if (!product) {
        acc.push({
          product_id: current.product_id,
          product_name: current.product_name,
          category_name: current.category_name,
          details: recipePart ? [recipePart] : [],
          // Lọc bước làm cho món này
          steps: steps.filter(s => s.product_id === current.product_id)
        });
      } else {
        if (recipePart && !product.details.find(d => d.recipe_id === recipePart.recipe_id)) {
          product.details.push(recipePart);
        }
      }
      return acc;
    }, []);

    res.json(formatted);
  } catch (err) {
    console.error("LỖI TẠI BACKEND:", err.message); // Ông nhìn vào Terminal của VS Code sẽ thấy lỗi gì
    res.status(500).send({ error: err.message });
  }
});

// 2. THAO TÁC VỚI NGUYÊN LIỆU (RECIPES)
app.post('/api/recipes', async (req, res) => {
  try {
    const { product_id, ingredient_id, amount, unit } = req.body;
    await sql.query`INSERT INTO recipes (product_id, ingredient_id, amount, unit) VALUES (${product_id}, ${ingredient_id}, ${amount}, ${unit})`;
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/recipes/:id', async (req, res) => {
  try {
    await sql.query`DELETE FROM recipes WHERE recipe_id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

app.put('/api/recipes/:id', async (req, res) => {
  try {
    const { amount, unit } = req.body;
    await sql.query`UPDATE recipes SET amount = ${amount}, unit = ${unit} WHERE recipe_id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

// 3. THAO TÁC VỚI BƯỚC LÀM (PROCESS_STEP)
app.post('/api/products/:id/steps', async (req, res) => {
  try {
    const { id } = req.params;
    const { steps } = req.body; 
    await sql.query`DELETE FROM processing_steps WHERE product_id = ${id}`;
    for (const step of steps) {
      await sql.query`INSERT INTO processing_steps (product_id, step_number, description) VALUES (${id}, ${step.step_number}, ${step.description})`;
    }
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

// 4. LẤY DANH SÁCH NGUYÊN LIỆU (Dùng cho Autocomplete ở Frontend)
app.get("/api/ingredients", async (req, res) => {
  try {
    const result = await sql.query`SELECT ingredient_id, name FROM ingredients ORDER BY name`;
    res.json(result.recordset);
  } catch (err) { res.status(500).send(err.message); }
});
// Api quản lý bao bì
// 1. Lấy danh sách tất cả bao bì trong kho
app.get('/api/packaging', async (req, res) => {
  try {
    const result = await sql.query`SELECT * FROM packaging ORDER BY name`;
    res.json(result.recordset);
  } catch (err) { res.status(500).send(err.message); }
});

// 2. Cập nhật số lượng kho (Nhập hàng/Kiểm kho)
app.put('/api/packaging/:id', async (req, res) => {
  try {
    const { quantity } = req.body;
    await sql.query`UPDATE packaging SET quantity = ${quantity} WHERE packaging_id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

// 3. Lấy định mức bao bì của các sản phẩm
app.get('/api/product-packaging', async (req, res) => {
  try {
    const result = await sql.query`
      SELECT pp.*, p.name as product_name, pk.name as pkg_name 
      FROM product_packaging pp
      JOIN products p ON pp.product_id = p.product_id
      JOIN packaging pk ON pp.packaging_id = pk.packaging_id`;
    res.json(result.recordset);
  } catch (err) { res.status(500).send(err.message); }
});

// 4. Thêm định mức bao bì cho món ăn
app.post('/api/product-packaging', async (req, res) => {
  try {
    const { product_id, packaging_id, quantity } = req.body;
    await sql.query`
      INSERT INTO product_packaging (product_id, packaging_id, quantity)
      VALUES (${product_id}, ${packaging_id}, ${quantity})`;
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});
// START SERVER
app.listen(3003, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('Backend chạy thành công');
});
