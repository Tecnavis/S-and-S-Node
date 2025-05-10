const Booking = require('../Model/booking');
const Driver = require('../Model/driver');
const Provider = require('../Model/provider');
const Company = require('../Model/company');
const Showroom = require('../Model/showroom');
const ShowroomStaff = require('../Model/showroomStaff');
const mongoose = require('mongoose');
const Vehicle = require('../Model/vehicle');
const { io } = require('../config/socket');
const { capitalizeFirstLetter, convertTo12HourFormat } = require('../utils/dateUtils');
const NotificationService = require('../services/notification.service');
const Staff = require('../Model/staff');
const agenda = require('../config/Agenda.config')()


// Controller to create a booking
exports.createBooking = async (req, res) => {
    try {
        const bookingData = req.body;

        const isFileNumberExisint = await Booking.findOne({ fileNumber: bookingData.fileNumber })

        if (isFileNumberExisint) {
            return res.status(400).json({ message: "Enter a unique file Number", success: false });
        }

        // Handle the case where 'company' is an empty string
        if (!bookingData.company || bookingData.company === "") {
            bookingData.company = null; // Or you can delete the field entirely if required
        }

        let source = null;

        if (bookingData.dummyEntity.id === 'dummy') {
            if (bookingData.dummyEntity.name === 'Dummy Driver') {
                bookingData.dummyDriverName = bookingData.dummyEntity.name
            } else {
                bookingData.dummyProviderName = bookingData.dummyEntity.name
            }
        } else {

            const getVehicleForService = (vehicles, serviceType) => {
                return vehicles.find(
                    (item) => item.serviceType.toString() === serviceType.toString()
                );
            };

            if (bookingData.driver) {
                source = await Driver.findById(bookingData.driver);
                if (!source) return res.status(404).json({ message: "Driver not found" });

            } else {
                source = await Provider.findById(bookingData.provider);
                if (!source) return res.status(404).json({ message: "Provider not found" });
            }

            const selectedVehicle = getVehicleForService(bookingData.driver ? source.vehicle : source.serviceDetails, bookingData.serviceType);
            if (!selectedVehicle) {
                return res.status(404).json({ message: "Vehicle not found for the selected service type" });
            }

            bookingData.vehicleNumber = selectedVehicle.vehicleNumber || "";
            bookingData.createdBy = req.user._id || req.user.id;
            bookingData.bookedByModel = "Admin";

        }

        const newBooking = new Booking(bookingData);
        await newBooking.save();

        const agendaInstance = await agenda;
        if (bookingData.pickupDate) {

            const dateNow = convertTo12HourFormat(bookingData.dateNow)
            const pickupTime = convertTo12HourFormat(bookingData.pickupDate);

            if (new Date(pickupTime) > new Date(dateNow)) {
                console.log('Scheduling future job');
                await agendaInstance.schedule(pickupTime, 'activate booking', {
                    bookingId: newBooking._id
                });
            }
            else {
                console.log('Running job immediately');
                await agendaInstance.now('activate booking', {
                    bookingId: newBooking._id
                });
            }
        } else {
            console.log('Running job immediately 2');
            await agendaInstance.now('activate booking', {
                bookingId: newBooking._id
            });
        }

        res.status(201).json({ message: 'Booking created successfully', booking: newBooking });

        // Populate and emit separately to improve response time
        process.nextTick(async () => {
            try {
                const populatedBooking = await Booking.findById(newBooking._id)
                    .populate('baselocation company driver provider')
                    .lean();

                if (populatedBooking) {
                    io.emit("newChanges", {
                        type: 'newBooking',
                        bookingId: newBooking._id,
                        newBooking: populatedBooking,
                    });
                }
            } catch (err) {
                console.error("Failed to populate and emit:", err.message);
            }
        });
    } catch (error) {
        if (error.name === "ValidationError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.errors,
            });
        }
        console.log(error)
        res.status(500).json({
            success: false,
            message: "An internal server error occurred",
            error: error.message,
        });
    }
};

// Controller to create a booking for showroom and showroom staff dashboard
exports.addBookingForShowroom = async (req, res) => {
    try {
        let bookingData = req.body;

        const showroomData = await Showroom.findById(bookingData.showroom).lean();

        if (!showroomData) {
            return res.status(404).json({
                message: 'Showroom not found. Please try another showroom.',
                success: false,
            })
        }

        const enrichedBookingData = {
            ...bookingData,
            dropoffLocation: showroomData.location,
            dropoffLatitudeAndLongitude: showroomData.latitudeAndLongitude,
            bookedBy: "Showroom",
            createdBy: req.user._id || req.user.id,
            bookedByModel: capitalizeFirstLetter(bookingData.bookingStatus) || 'Showroom'
        };

        const newBooking = await Booking.create(enrichedBookingData);


        res.status(201).json({
            message: 'Booking created successfully',
            booking: newBooking
        });

        // Populate and emit separately to improve response time
        process.nextTick(async () => {
            try {
                const populatedBooking = await Booking.findById(newBooking._id)
                    .populate('baselocation company driver provider')
                    .lean();

                if (populatedBooking) {
                    io.emit("newChanges", {
                        type: 'newBooking',
                        bookingId: newBooking._id,
                        newBooking: populatedBooking,
                    });
                }
            } catch (err) {
                console.error("Failed to populate and emit:", err.message);
            }
        });
    } catch (error) {
        if (error.name === "ValidationError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.errors,
            });
        }

        res.status(500).json({
            success: false,
            message: "An internal server error occurred",
            error: error.message,
        });
    }
}

// Controller to create a booking
exports.createBookingNoAuth = async (req, res) => {
    try {
        const bookingData = req.body;

        // Handle the case where 'company' is an empty string
        if (!bookingData.company || bookingData.company === "") {
            bookingData.company = null; // Or you can delete the field entirely if required
        }

        // Fetch driver details
        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(bookingData.baselocation)) bookingData.baselocation = null;
        if (!mongoose.Types.ObjectId.isValid(bookingData.showroom)) bookingData.showroom = null;
        if (!mongoose.Types.ObjectId.isValid(bookingData.serviceType)) bookingData.serviceType = null;

        const newBooking = new Booking(bookingData);

        await newBooking.save();

        res.status(201).json({ message: 'Booking created successfully', booking: newBooking });
    } catch (error) {
        console.log(error)
        if (error.name === "ValidationError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.errors,
            });
        }

        res.status(500).json({
            success: false,
            message: "An internal server error occurred",
            error: error.message,
        });
    }
};

//Helper function for check and udpate the vehicle serviceKM 
const checkVehicleServiceStatus = async (booking) => {
    try {
        // Step 1: Find the vehicle associated with the booking
        const driver = await Driver.findById(booking.driver);
        if (!driver) {
            throw new Error("Driver not found");
        }

        // Find the selected vehicle for the driver
        const selectedVehicle = driver.vehicle.find(
            (item) => item.serviceType.toString() === booking.serviceType.toString()
        );

        if (!selectedVehicle) {
            throw new Error("Vehicle not found for the selected service type");
        }

        const vehicle = await Vehicle.findOne({ serviceVehicle: selectedVehicle.vehicleNumber });
        if (!vehicle) {
            throw new Error("Vehicle details not found");
        }

        // Step 2: Update the vehicle's odometer with the new booking's distance
        const newOdometerValue = vehicle.totalOdometer + booking.totalDistence;
        const update = {}

        // Step 3: Check if the vehicle has reached its service KM limit then set default value
        if ((newOdometerValue - vehicle.totalOdometer) >= vehicle.serviceKM) {
            update.vehicleServiceDismissed = false
            update.DismissedBy = null
            update.vehicleServiceDue = false
            update.valid = false
        }

        // Step 4: Update the vehicle's odometer
        await Vehicle.findByIdAndUpdate(vehicle._id, {
            totalOdometer: newOdometerValue,
            previousOdometer: vehicle.totalOdometer,
            ...update
        });

        return {
            success: true,
            message: "Vehicle odometer updated successfully.",
            vehicleId: vehicle._id,
            newOdometerValue,
        };
    } catch (error) {
        console.error("Error checking vehicle service status:", error);
        return { success: false, message: "Error processing request", error: error.message };
    }
};

// Controller to get Order completed booking  by search query
exports.getOrderCompletedBookings = async (req, res) => {
    try {
        let { search, startDate, endDate, page = 1, limit = 10 } = req.query;

        // Convert page and limit to integers
        page = parseInt(page, 10);
        limit = parseInt(limit, 10);

        const query = {
            status: "Order Completed", // Filter only bookings with this status
            accountantVerified: { $ne: true } // Exclude bookings where accountantVerified is true
        };

        // Handle search
        if (search) {
            query._includeHidden = true;
            search = search.trim();
            const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
            if (dateRegex.test(search)) {
                const [day, month, year] = search.split('/');
                const startOfDay = new Date(`${year}-${month}-${day}T00:00:00Z`);
                const endOfDay = new Date(`${year}-${month}-${day}T23:59:59Z`);

                query.createdAt = {
                    $gte: startOfDay,
                    $lte: endOfDay,
                };
            } else {
                const searchRegex = new RegExp(search.replace(/\s+/g, ''), 'i');
                const matchingDrivers = await Driver.find({ phone: searchRegex }).select('_id');
                const matchingProviders = await Provider.find({ phone: searchRegex }).select('_id');

                query.$or = [
                    { fileNumber: searchRegex },
                    { mob1: searchRegex },
                    { customerVehicleNumber: searchRegex },
                    { bookedByModel: searchRegex },
                    { driver: { $in: matchingDrivers.map(d => d._id) } },
                    { provider: { $in: matchingProviders.map(p => p._id) } },
                ];
            }
        }

        // Handle date range filter
        if (startDate || endDate) {
            query.createdAt = query.createdAt || {};
            if (startDate) {
                query.createdAt.$gte = new Date(startDate);
            }
            if (endDate) {
                query.createdAt.$lte = new Date(endDate);
            }
        }

        // Pagination and sorting by createdAt in descending order
        const total = await Booking.countDocuments(query);
        const bookings = await Booking.find(query)
            .populate('baselocation')
            .populate('serviceType')
            .populate('company')
            .populate('driver')
            .populate('provider')
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ createdAt: -1 });  // Sorting by createdAt in descending order

        res.status(200).json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            bookings,
        });
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ message: 'Server error while fetching bookings' });
    }
};
// ------------------------------
// Controller to get Booking Completed by search query
exports.getAllBookings = async (req, res) => {
    try {
        let {
            search,
            startDate,
            endDate,
            endingDate,
            forDriverReport,
            forCompanyReport,
            forStaffReport,
            page = 1,
            limit = 10,
            status = '',
            driverId,
            providerId,
            companyId,
            verified,
            staffId
        } = req.query;

        // Convert page and limit to integers
        page = parseInt(page, 10);
        limit = parseInt(limit, 10);

        const query = {};

        if (status) {
            if (Array.isArray(status)) {
                query.status = { $nin: status }
            } else {
                query.status = { $ne: status }
            }
        }

        // If driverId as query then fetch drivers bookings
        if (driverId) {
            query.driver = new mongoose.Types.ObjectId(driverId);
        }

        // If driverId as query then fetch drivers bookings
        if (verified) {
            query.verified = verified
        }

        // If providerId as query then fetch provider bookings
        if (providerId) {
            query.provider = new mongoose.Types.ObjectId(providerId);
        }

        // If providerId as query then fetch company bookings
        if (companyId) {
            query.company = new mongoose.Types.ObjectId(companyId);
            query.workType = 'RSAWork'
        }

        if (staffId) {
            query.receivedUserId = new mongoose.Types.ObjectId(staffId)
        }

        // Handle search
        if (search) {
            search = search.trim();
            const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;

            // Handle date search separately
            if (dateRegex.test(search)) {
                const [day, month, year] = search.split('/');
                const startOfDay = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
                const endOfDay = new Date(`${year}-${month}-${day}T23:59:59.999Z`);
                query.createdAt = { $gte: startOfDay, $lte: endOfDay };
            } else {
                // Escape special regex characters
                const escapedSearch = search.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

                // Search conditions array
                const searchConditions = [
                    { fileNumber: escapedSearch },
                    { mob1: escapedSearch },
                    { customerVehicleNumber: escapedSearch },
                ];

                // Only search drivers/providers if search is numeric
                if (/^\d+$/.test(search)) {
                    const [matchingDrivers, matchingProviders] = await Promise.all([
                        Driver.find({ phone: searchRegex }).select('_id').lean(),
                        Provider.find({ phone: searchRegex }).select('_id').lean()
                    ]);

                    if (matchingDrivers.length > 0) {
                        searchConditions.push({ driver: { $in: matchingDrivers.map(d => d._id) } });
                    }
                    if (matchingProviders.length > 0) {
                        searchConditions.push({ provider: { $in: matchingProviders.map(p => p._id) } });
                    }
                }

                query.$or = searchConditions;
            }
        }

        if (startDate && endingDate) {
            const startOfDay = new Date(`${startDate}T00:00:00.000Z`);
            const endOfDay = new Date(`${endingDate}T23:59:59.999Z`);

            query.createdAt = {
                $gte: startOfDay,
                $lte: endOfDay
            };
        }
        // Pagination and sorting by createdAt in descending order
        const total = await Booking.countDocuments(query);
        const bookings = await Booking.find(query)
            .populate('baselocation')
            .populate('serviceType')
            .populate('company')
            .populate('driver')
            .populate('provider')
            .populate('receivedUserId')
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ createdAt: -1 })
            .lean()

        const balanceAmount = bookings.reduce((total, booking) => {
            return total + booking.receivedAmount;
        }, 0);
        query.workType = { $ne: 'RSAWork' };

        // Aggregate data for total amounts
        const aggregationResult = await Booking.aggregate([
            {
                $match: {
                    ...query,
                    ...((forDriverReport !== undefined || forStaffReport !== undefined || forCompanyReport !== undefined) && { cashPending: false }),
                    ...((forCompanyReport !== undefined) && { workType: 'RSAWork' })
                }
            },
            {
                $group: {
                    _id: null,
                    totalCollected: {
                        $sum: forCompanyReport ? "$receivedAmountByCompany" : "$receivedAmount"
                    },
                    totalOverall: { $sum: "$totalAmount" }
                }
            }
        ]);

        // Extract financial data from aggregation result
        const totalCollectedAmount = aggregationResult[0]?.totalCollected || 0;
        const overallAmount = aggregationResult[0]?.totalOverall || 0;
        const balanceAmountToCollect = overallAmount - totalCollectedAmount;
        return res.status(200).json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            bookings,
            balanceAmount,
            financials: {
                totalCollectedAmount,
                overallAmount,
                balanceAmountToCollect: balanceAmountToCollect
            }
        });
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ message: 'Server error while fetching bookings' });
    }
};

// Controller to get a booking by ID
exports.getBookingById = async (req, res) => {
    const { id } = req.params;

    try {
        const booking = await Booking.findById(id)
            .populate('baselocation') // Populate related documents
            .populate('serviceType')
            .populate('company')
            .populate('driver')
            .populate('provider');

        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        res.status(200).json(booking);
    } catch (error) {
        console.error('Error fetching booking by ID:', error);
        res.status(500).json({ message: 'Server error while fetching the booking' });
    }
};

// Controller to update a booking by ID
exports.updateBooking = async (req, res) => {
    const { id } = req.params;
    const updatedData = req.body;

    try {
        // Fetch the existing booking
        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        if (updatedData.workType === 'PaymentWork') {
            updatedData.company = null
        }

        if (booking.status === "Rejected") {
            updatedData.status = 'Booking Added'
        }

        // Check if the body contains 'driver' and handle 'provider' if it exists
        if (updatedData.driver) {
            const booking = await Booking.findById(id); // Fetch the existing booking to check for the provider
            if (booking && booking.provider) {
                // If there's a provider and driver is being set, remove provider and set driver
                await Booking.updateOne({ _id: id }, { $unset: { provider: "" } }); // Remove provider
            }
            // Fetch driver details
            const driver = await Driver.findById(updatedData.driver);
            if (!driver) {
                return res.status(404).json({ message: "Driver not found" });
            }

            // Find the selected vehicle for the driver
            const selectedVehicle = driver.vehicle.find(
                (item) => item.serviceType.toString() === updatedData.serviceType.toString()
            );

            if (!selectedVehicle) {
                return res.status(404).json({ message: "Vehicle not found for the selected service type" });
            }

            updatedData.vehicleNumber = selectedVehicle.vehicleNumber
        }

        // Check if the body contains 'provider' and handle 'driver' if it exists
        if (updatedData.provider) {
            const booking = await Booking.findById(id); // Fetch the existing booking to check for the driver
            if (booking && booking.driver) {
                // If there's a driver and provider is being set, remove driver and set provider
                await Booking.updateOne({ _id: id }, { $unset: { driver: "" } }); // Remove driver
            }
        }
        // Handle uploaded images
        if (req.files && req.files.length > 0) {
            if (updatedData.dropoffTime) {
                updatedData.dropoffImages = req.files.map(file => file.filename);
            } else {
                updatedData.pickupImages = req.files.map(file => file.filename);
            }
        }

        // update driver transfer amount
        if (updatedData.transferedSalary) {
            const newTransferedSalary = (booking.transferedSalary || 0) + updatedData.transferedSalary;
            if (newTransferedSalary !== booking.driverSalary) {
                return res.status(400).json({
                    message: 'Driver Transfer amount should be equal to Driver Salary'
                });
            }
            updatedData.transferedSalary = newTransferedSalary
        }

        if (updatedData.invoiceNumber) {
            booking.invoiceNumber = updatedData.invoiceNumber
            // booking.invoiceStatus = 
        }

        // If the total ammount changed then check with redeemed if redeem for this booking
        if (
            updatedData.totalAmount &&
            booking.rewardAmount &&
            booking.totalAmount !== updatedData.totalAmount
        ) {
            updatedData.totalAmount -= booking.rewardAmount;
        }


        const updatedBooking = await Booking.findByIdAndUpdate(id, updatedData, { new: true })
            .populate('baselocation') // Populate related documents
            .populate('serviceType')
            .populate('company')
            .populate('driver')
            .populate('provider');

        if (!updatedBooking) {
            return res.status(404).json({ message: 'Booking not found' });
        }
        // Notify booking update for realtime udpate 
        // emit an event to socket connection for realtime changes
        io.emit("newChanges", {
            type: 'update',
            bookingId: updatedBooking._id,
            status: updatedBooking.status,
            updatedBooking
        })
        res.status(200).json({ message: 'Booking updated successfully', booking: updatedBooking });
    } catch (error) {
        console.error('Error updating booking:', error);
        res.status(500).json({ message: 'Error updating booking', error: error.message });
    }
};

// Controller for updatatin pickup details from admin side 
exports.updatePickupByAdmin = async (req, res) => {
    try {
        const { id } = req.params;

        const {
            totalDistence,
            totalAmount,
            pickupTime,
            dropoffTime,
            serviceVehicleNumber,
            driverSalaryCheck,
            compnayAmountCheck,
            remark,
        } = req.body;

        // Update the booking details
        const updatedBooking = await Booking.findByIdAndUpdate(
            id,
            {
                totalDistence,
                totalAmount,
                pickupTime,
                dropoffTime,
                driverSalaryCheck,
                compnayAmountCheck,
                remark,
                serviceVehicleNumber,
                status: 'Order Completed',
            },
            { new: true } // Return the updated document
        );

        await checkVehicleServiceStatus(updatedBooking)

        if (!updatedBooking) {
            return res.status(404).json({ message: 'Booking not found.' });
        }
        // emit an event to socket connection for realtime changes
        io.emit("newChanges", {
            type: 'update',
            bookingId: updatedBooking._id,
            status: updatedBooking.status
        })

        res.status(200).json({
            message: 'Booking updated successfully.',
            booking: updatedBooking,
        });
    } catch (error) {
        console.error('Error updating booking:', error);
        res.status(500).json({ message: 'Internal server error.', error: error.message });
    }
};
exports.uploadImage = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    const filename = req.file.filename;
    res.status(200).json({ filename });
};

// remove the pickup image 
exports.removePickupImages = async (req, res) => {
    const { id, index } = req.params;

    if (!id) {
        return res.status(400).json({ message: "ID is required" });
    }

    try {
        // Find the booking by ID
        const booking = await Booking.findById(id);

        if (!booking) {
            return res.status(404).json({ message: "Booking not found" });
        }

        const pickupImages = booking.pickupImages;

        // Check if the index is valid
        if (index < 0 || index >= pickupImages.length) {
            return res.status(400).json({ message: "Invalid index" });
        }

        // Remove the image at the specified index
        const removedImage = pickupImages.splice(index, 1);
        // Check after removal
        booking.pickupImagePending = pickupImages.length < 3;

        // Save the updated booking
        booking.pickupImages = pickupImages;
        await booking.save();

        res.status(200).json({
            message: "Image removed successfully",
            removedImage,
            pickupImagePending: booking.pickupImagePending,

        });
    } catch (error) {
        console.error("Error removing pickup image:", error);
        res.status(500).json({ error: error.message });
    }
};

// add pickup images
exports.addPickupImages = async (req, res) => {
    const { id } = req.params;

    try {
        // Find the booking document by ID
        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        // Get new image paths from the uploaded files
        const newImages = req.files && req.files.length ? req.files.map(file => file.filename) : [];
        console.log(newImages)

        if (!newImages.length) {
            return res.status(400).json({ message: 'No images were uploaded.' });
        }

        // Calculate the total number of images (existing + new)
        const totalImages = booking.pickupImages.length + newImages.length; // For pickup

        // If total images exceed the limit, return an error
        if (totalImages > 6) {
            return res.status(400).json({
                message: `Limit exceeded. You can upload a maximum of 6 images for pickup images. You already have ${booking.pickupImages.length} images.`,
            });
        }

        // Push new images to the pickupImages array
        booking.pickupImages.push(...newImages);
        // ✅ Set pickupImagePending based on count
        if (booking.pickupImages.length < 3) {
            booking.pickupImagePending = true;
        } else {
            booking.pickupImagePending = false;
        }
        // Save the updated booking
        await booking.save();

        // Respond with the updated pickup images
        res.status(200).json({
            message: 'Pickup images added successfully',
            pickupImages: booking.pickupImages,
            pickupImagePending: booking.pickupImagePending,

        });
    } catch (error) {
        console.error('Error in addPickupImages:', error);
        res.status(500).json({ message: 'Error updating booking', error: error.message });
    }
};

// remove the dropoff image 
exports.removeDropoffImages = async (req, res) => {
    const { id, index } = req.params;

    if (!id) {
        return res.status(400).json({ message: "ID is required" });
    }

    try {
        // Find the booking by ID
        const booking = await Booking.findById(id);

        if (!booking) {
            return res.status(404).json({ message: "Booking not found" });
        }

        const dropoffImages = booking.dropoffImages;

        // Check if the index is valid
        if (index < 0 || index >= dropoffImages.length) {
            return res.status(400).json({ message: "Invalid index" });
        }

        // Remove the image at the specified index
        const removedImage = dropoffImages.splice(index, 1);
        // Check after removal
        booking.dropoffImagePending = dropoffImages.length < 3;

        // Save the updated booking
        booking.dropoffImages = dropoffImages;
        await booking.save();

        res.status(200).json({
            message: "Image removed successfully",
            removedImage,
            dropoffImagePending: booking.dropoffImagePending,

        });
    } catch (error) {
        console.error("Error removing dropoff image:", error);
        res.status(500).json({ error: error.message });
    }
};

// add dropoff images
exports.addDropoffImages = async (req, res) => {

    const { id } = req.params;

    try {
        // Find the booking document by ID
        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        // Get new image paths from the uploaded files
        const newImages = req.files && req.files.length ? req.files.map(file => file.filename) : [];
        console.log(newImages)

        if (!newImages.length) {
            return res.status(400).json({ message: 'No images were uploaded.' });
        }

        // Calculate the total number of images (existing + new)
        const totalImages = booking.dropoffImages.length + newImages.length; // For dropoff

        // If total images exceed the limit, return an error
        if (totalImages > 6) {
            return res.status(400).json({
                message: `Limit exceeded. You can upload a maximum of 6 images for dropoff images. You already have ${booking.dropoffImages.length} images.`,
            });
        }

        // Push new images to the pickupImages array
        booking.dropoffImages.push(...newImages);
        // ✅ Set dropoffImagePending based on count
        if (booking.dropoffImages.length < 3) {
            booking.dropoffImagePending = true;
        } else {
            booking.dropoffImagePending = false;
        }
        // Save the updated booking
        await booking.save();

        // Respond with the updated dropoff images
        res.status(200).json({
            message: 'Dropoff images added successfully',
            dropoffImages: booking.dropoffImages,
            dropoffImagePending: booking.dropoffImagePending,

        });
    } catch (error) {
        console.error('Error in addDropoffImages:', error);
        res.status(500).json({ message: 'Error updating booking', error: error.message });
    }
};

//Editing filenumber 
exports.updateFilenumber = async (req, res) => {
    const { fileNumber } = req.body;
    const { id } = req.params;

    try {
        // Find the booking by ID and update the fileNumber
        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: "Booking not found" });
        }

        booking.fileNumber = fileNumber; // Update the fileNumber
        await booking.save(); // Save the updated booking

        res.status(200).json({ message: "Filenumber updated successfully" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error updating booking", error: error.message });
    }
};

//   Booking verify 
exports.verifyBooking = async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch the booking details
        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found.' });
        }
        // 🔥 ADD this check here
        if (booking.cashPending) {
            return res.status(400).json({ message: 'Cannot verify. Cash is pending.' });
        }
        if (booking.pickupImagePending || booking.dropoffImagePending) {
            return res.status(400).json({ message: 'Image is pending.' });
        }
        if (booking.inventoryImagePending) {
            return res.status(400).json({ message: 'Inventory Image is pending.' });
        }

        // Update booking status to verified
        const updatedBooking = await Booking.findByIdAndUpdate(
            id,
            { verified: true, feedbackCheck: true },
            { new: true }
        );

        if (!updatedBooking) {
            return res.status(404).json({ message: 'Booking not found.' });
        }

        res.status(200).json({
            message: 'Booking verified successfully.',
            booking: updatedBooking,
        });

    } catch (error) {
        console.error('Error verifying booking:', error);
        res.status(500).json({ message: 'Internal server error.', error: error.message });
    }
};

// posting feedback 
exports.postFeedback = async (req, res) => {
    try {
        const { id } = req.params;
        const { feedback } = req.body;

        // Validate booking ID
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid booking ID" });
        }

        // Validate feedback input
        if (!Array.isArray(feedback) || feedback.length === 0) {
            return res.status(400).json({ message: "Feedback array is required" });
        }

        // Calculate total points from feedback
        let totalPoints = feedback.reduce((sum, item) => {
            const yesPoint = Number(item.yesPoint) || 0;
            const noPoint = Number(item.noPoint) || 0;
            return sum + (item.response === "yes" ? yesPoint : noPoint);
        }, 0);

        // Find the booking
        const booking = await Booking.findById(id);
        if (!booking) {
            return res.status(404).json({ message: "Booking not found" });
        }

        // Update feedback and totalPoints in Booking
        const updatedBooking = await Booking.findByIdAndUpdate(
            id,
            {
                $set: {
                    feedback: feedback,
                    totalPoints: totalPoints,
                    feedbackCheck: true
                }
            },
            { new: true }
        );

        // If the booking contains a valid driver, update the driver's rewardPoints
        if (booking.driver && mongoose.Types.ObjectId.isValid(booking.driver)) {
            const driverExists = await Driver.findById(booking.driver);
            if (driverExists) {
                const updated = await Driver.findByIdAndUpdate(
                    booking.driver,
                    { $inc: { rewardPoints: totalPoints } },
                    { new: true }
                );
            }
        }

        // **Additional Condition: Update Driver Salary if workType is "paymentWork"**
        if (booking.driver) {
            const selectedDriver = await Driver.findById(booking.driver);

            if (selectedDriver) {
                console.log('Total Amount:', booking.totalAmount, 'Driver Salary:', booking.driverSalary);

                selectedDriver.driverSalary = Number(selectedDriver.driverSalary) || 0;
                const bookingDriverSalary = Number(booking.driverSalary);

                if (!isNaN(booking.totalAmount) && !isNaN(bookingDriverSalary)) {
                    selectedDriver.driverSalary += bookingDriverSalary;
                    await selectedDriver.save();
                } else {
                    return res.status(400).json({ message: "Invalid totalAmount or driverSalary" });
                }
            }
        }

        res.status(200).json({
            message: "Feedback and driver salary updated successfully",
            booking: updatedBooking
        });

    } catch (error) {
        console.error("Error in postFeedback:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// accountant verifying 
exports.accountVerifying = async (req, res) => {
    const { id } = req.params

    try {
        const updatedBooking = await Booking.findByIdAndUpdate(
            id,
            {
                accountantVerified: true
            },
            { new: true }
        );
        if (!updatedBooking) {
            return res.status(404).json({ message: 'Booking not found.' });
        }

        res.status(200).json({
            message: 'Accountant verified successfully.',
            booking: updatedBooking,
        });
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: 'Internal server error.', error: error.message });
    }
}

//Fetch approved bookings
exports.getApprovedBookings = async (req, res) => {
    try {
        let { search, startDate, endDate, page = 1, limit = 10 } = req.query;

        // Convert page and limit to integers
        page = parseInt(page, 10);
        limit = parseInt(limit, 10);

        // Base query for approved bookings
        const query = {
            status: "Order Completed", // Filter only bookings with this status
            accountantVerified: true,  // Ensure accountantVerified is true
        };

        // Handle search
        if (search) {
            search = search.trim();
            query._includeHidden = true;
            const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
            if (dateRegex.test(search)) {
                const [day, month, year] = search.split('/');
                const startOfDay = new Date(`${year}-${month}-${day}T00:00:00Z`);
                const endOfDay = new Date(`${year}-${month}-${day}T23:59:59Z`);

                query.createdAt = {
                    $gte: startOfDay,
                    $lte: endOfDay,
                };
            } else {
                const searchRegex = new RegExp(search.replace(/\s+/g, ''), 'i');
                const matchingDrivers = await Driver.find({ phone: searchRegex }).select('_id');
                const matchingProviders = await Provider.find({ phone: searchRegex }).select('_id');

                query.$or = [
                    { customerName: searchRegex }, // Replaced fileNumber with customerName
                    { mob1: searchRegex },
                    { customerVehicleNumber: searchRegex },
                    { bookedByModel: searchRegex },
                    { driver: { $in: matchingDrivers.map(d => d._id) } },
                    { provider: { $in: matchingProviders.map(p => p._id) } },
                ];
            }
        }

        // Handle date range filter
        if (startDate || endDate) {
            query.createdAt = query.createdAt || {};
            if (startDate) {
                query.createdAt.$gte = new Date(startDate);
            }
            if (endDate) {
                query.createdAt.$lte = new Date(endDate);
            }
        }

        // Pagination and sorting by createdAt in descending order
        const total = await Booking.countDocuments(query);
        const bookings = await Booking.find(query)
            .populate('baselocation')
            .populate('serviceType')
            .populate('company')
            .populate('driver')
            .populate('provider')
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ createdAt: -1 });  // Sorting by createdAt in descending order

        res.status(200).json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            bookings,
        });
    } catch (error) {
        console.error('Error fetching approved bookings:', error);
        res.status(500).json({ message: 'Server error while fetching approved bookings' });
    }
};

// Controller to get Booking (based on status)
exports.getAllBookingsBasedOnStatus = async (req, res) => {
    try {
        let { status = '', search, page = 1, limit = 10 } = req.query;

        // Convert page and limit to integers
        page = parseInt(page, 10);
        limit = parseInt(limit, 10);

        let query = {};

        if (search) {
            search = search.trim();
            query._includeHidden = true;
            const searchRegex = new RegExp(search.replace(/\s+/g, ''), 'i');
            const matchingDrivers = await Driver.find({ name: searchRegex }).select('_id');

            query.$or = [
                { fileNumber: searchRegex },
                { mob1: searchRegex },
                { customerVehicleNumber: searchRegex },
                { customerName: searchRegex },
                { bookedByModel: searchRegex },
                { driver: { $in: matchingDrivers.map(d => d._id) } },
            ];
        } else {

            if (status === "Order Completed") {

                query.$and = [
                    { status: "Order Completed" },
                    {
                        $or: [
                            { cashPending: false },
                            { cashPending: { $exists: false } }
                        ]
                    }
                ];

            } else if (status === "OngoingBookings") {
                query.status = {
                    $in: [
                        "Booking Added",
                        "called to customer",
                        "Order Received",
                        "On the way to pickup location",
                        "Vehicle Picked",
                        "Vehicle Confirmed",
                        "To DropOff Location",
                        "On the way to dropoff location",
                        "Vehicle Dropped",
                        "Booking Added",
                        "Rejected"
                    ]
                };
                query.$or = [
                    { cashPending: false },
                    { cashPending: { $exists: false } }
                ];
            } else if (status === "CashPendingBookings") {
                query.cashPending = true
            }
        }


        const total = await Booking.countDocuments(query);

        const bookings = await Booking.find(query)
            .populate('baselocation')
            .populate('serviceType')
            .populate('company')
            .populate('driver')
            // .populate('provider')
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ createdAt: -1 });

        res.status(200).json({
            bookings,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        });
    } catch (error) {
        console.error('Error fetching bookings:', error.message);
        res.status(500).json({ message: 'Server error while fetching bookings' });
    }
};

//Controller to settle booking amount 
exports.settleAmount = async (req, res) => {
    try {
        const { id } = req.params;
        const { partialAmount, receivedUser, role } = req.body;
        const userId = req.user.id || req.user._id

        const booking = await Booking.findById(id);

        if (!booking) {
            return res.status(404).json({
                message: 'Booking not found'
            });
        }

        console.log(role, req.body)
        if (role !== 'admin' && receivedUser === 'Staff') {
            booking.receivedUserId = userId
            booking.receivedUser = 'Staff'

            await Staff.findByIdAndUpdate(userId, {
                $inc: {
                    cashInHand: partialAmount
                }
            })
        }

        if (booking.company) {
            booking.receivedAmountByCompany += partialAmount;
            if (booking.totalAmount <= booking.receivedAmountByCompany) {
                booking.cashPending = false;
            }
        } else {
            booking.partialAmount = booking.partialAmount || 0;
            booking.partialAmount += partialAmount;
            if (booking.partialAmount < booking.totalAmount) {
                booking.partialPayment = true;
                booking.cashPending = true;
            } else if (booking.partialAmount === booking.totalAmount) {
                booking.partialPayment = false;
                booking.cashPending = false;
            }
        }

        await booking.save();

        return res.status(200).json({
            message: "Settle amount updated",
            booking
        });

    } catch (error) {
        console.error('Error settling booking amount:', error.message);
        res.status(500).json({ message: 'Server error while settling booking amount.' });
    }
};

//Controller for update booking as approved 
exports.updateBookingApproved = async (req, res) => {
    try {
        const { id } = req.params

        const booking = await Booking.findById(id)

        if (!booking) {
            return res.status(404).json({ message: 'Booking not found.' });
        }

        booking.accountantVerified = true
        await booking.save()

        return res.status(200).json({
            message: "Booking updated successfully, approved"
        })
    } catch (error) {
        console.log(error.message)
        return res.status(500).json({
            message: error.message
        })
    }
}

//Controller for distribute received amount
exports.distributeReceivedAmount = async (req, res) => {
    const { receivedAmount, driverId, bookingIds, workType = 'RSAWork' } = req.body;

    try {
        let remainingAmount = receivedAmount;
        const selectedBookingIds = [];

        const userId = req.user_id || req.user?.id;

        let receivedField = workType === 'PaymentWork' ? '$receivedAmountByCompany' : '$receivedAmount';

        // Fetch bookings from DB where receivedUser is NOT "Staff" and balance > 0
        const bookings = await Booking.find({
            _id: { $in: bookingIds },
            workType: { $ne: workType },
            $expr: { $gt: ["$totalAmount", { $ifNull: [receivedField, 0] }] }
        }).sort({ createdAt: -1 });

        // Update bookings by distributing receivedAmount
        for (const booking of bookings) {
            if (remainingAmount <= 0) break; // Stop if amount is fully distributed

            const bookingBalance = booking.totalAmount - (booking.receivedAmount || 0);
            if (bookingBalance > 0) {
                const appliedAmount = Math.min(remainingAmount, bookingBalance);

                booking.receivedAmount = (booking.receivedAmount || 0) + appliedAmount;
                remainingAmount -= appliedAmount;

                if (workType === 'PaymentWork') {
                    booking.receivedUserId = new mongoose.Types.ObjectId(userId);
                    booking.receivedUser = 'Staff'
                }

                selectedBookingIds.push(booking._id);

                await booking.save(); // Save updated booking to DB
            }
        }

        //Deduct remaining amount from driver's advance
        const deductRemainingFromAdvance = async (remainingAmount, driverId) => {
            try {
                const driver = await Driver.findById(driverId);
                if (!driver) {
                    throw new Error("Driver not found");
                }
                if (driver.advance && driver.advance > 0) {
                    driver.advance -= remainingAmount;
                }
                await driver.save();
            } catch (error) {
                console.error("Error deducting from driver advance:", error);
                throw new Error("Failed to deduct advance amount");
            }
        };

        // Deduct remaining amount from the driver's advance if not fully used
        if (remainingAmount > 0) {
            await deductRemainingFromAdvance(remainingAmount, driverId);
        }

        return res.status(200).json(
            { message: "Amount distributed successfully" }
        )
    } catch (error) {
        console.log(error.message)
        return res.status(500).json({
            message: error.message
        })
    }
}

//Controller for udpate driver balance salary
exports.updateBalanceSalary = async (req, res) => {
    const { bookingIds, totalAmount } = req.body
    try {
        let amount = Number(totalAmount) || 0;

        const bookings = await Booking.find({
            _id: { $in: bookingIds }
        })

        for (const booking of bookings) {
            let balanceSalary = (Number(booking.driverSalary) || 0) - (Number(booking.transferedSalary) || 0);

            const transferAmount = Math.min(balanceSalary, amount);

            booking.transferedSalary = (Number(booking.transferedSalary) || 0) + transferAmount
            amount -= transferAmount;

            await booking.save();

            if (amount <= 0) break;
        }

        return res.status(200).json({
            message: "Driver balance salary updated successfully",
            remainingAmount: amount
        });

    } catch (error) {
        console.log(error.message)
        return res.status(500).json({
            message: error.message
        })
    }
}

// Controller for get booking for showroom dashboard 
exports.getBookingsForShowroom = async (req, res) => {
    try {
        const {
            showroom,
            status,
            serviceType,
            serviceCategory,
            startDate,
            endDate,
            search,
            page = 1,
            limit = 10,
            staffId
        } = req.query;

        // Validate required showroom
        if (!showroom || !mongoose.Types.ObjectId.isValid(showroom)) {
            return res.status(400).json({
                success: false,
                message: 'Valid showroom is required'
            });
        }

        // Build base query
        const query = {
            showroom: new mongoose.Types.ObjectId(showroom)
        };

        // Add status filter if provided
        if (status) {
            if (Array.isArray(status)) {
                query.status = { $in: status };
            } else {
                query.status = status;
            }
        }

        // Add service category filter
        if (serviceCategory) {
            query.serviceCategory = serviceCategory;
        }

        // Search functionality
        if (search) {
            query._includeHidden = true;
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { fileNumber: searchRegex },
                { customerName: searchRegex },
                { customerVehicleNumber: searchRegex },
                { mob1: searchRegex }
            ];
        }

        // Staff-specific filter (if staffId is provided)
        if (staffId && mongoose.Types.ObjectId.isValid(staffId)) {
            const staff = await ShowroomStaff.findById(staffId);
            if (!staff) {
                return res.status(404).json({
                    success: false,
                    message: 'Staff member not found'
                });
            }
        }

        // Convert page and limit to numbers
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        // Population configuration
        const populationOptions = [
            { path: 'showroom', select: 'name location phone' },
        ];

        // Execute query with pagination
        const [total, bookings] = await Promise.all([
            Booking.countDocuments(query),
            Booking.find(query)
                .populate(populationOptions)
                .sort({ createdAt: -1 })
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .lean()
        ]);

        // Format response
        const response = {
            success: true,
            data: {
                bookings,
                pagination: {
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(total / limitNum)
                },
                // stats: stats[0] || {
                //     totalBookings: 0,
                //     totalRevenue: 0,
                //     pendingBookings: 0,
                //     completedBookings: 0
                // }
            }
        };
        console.log(query)
        res.status(200).json(response);

    } catch (error) {
        console.error('Error in getBookingsForShowroom:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching showroom bookings',
            error: error.message
        });
    }
};

exports.getBookingsForShowroomStaff = async (req, res) => {
    try {
        const { status, search, page = 1, limit = 10 } = req.query;
        const staffId = new mongoose.Types.ObjectId(req.user.id);

        // Build query with proper status handling
        const query = { createdBy: staffId };

        // Handle status (array or single value)
        if (status) {
            if (Array.isArray(status)) {
                query.status = { $ne: "Order Completed" };
            } else {
                query.status = status;
            }
        }

        // Handle search
        if (search) {
            query._includeHidden = true;
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { fileNumber: searchRegex },
                { customerName: searchRegex },
                { customerVehicleNumber: searchRegex },
                { mob1: searchRegex }
            ];
        }

        console.log("Final query:", JSON.stringify(query, null, 2));

        // Execute queries
        const [total, bookings] = await Promise.all([
            Booking.countDocuments(query),
            Booking.find(query)
                .populate({
                    path: 'showroom',
                    select: 'name location phone',
                    options: { lean: true }
                })
                .sort({ createdAt: -1 })
                .skip((parseInt(page, 10) - 1) * parseInt(limit, 10))
                .limit(parseInt(limit, 10))
                .lean()
                .exec()
        ]);

        // Populate bookedBy
        const populatedBookings = await Promise.all(
            bookings.map(async (booking) => {
                if (booking.createdBy && booking.bookedByModel) {
                    try {
                        const model = mongoose.model(booking.bookedByModel);
                        booking.createdBy = await model.findById(booking.createdBy)
                            .select('name')
                            .lean()
                            .exec();
                    } catch (err) {
                        console.error(`Population error: ${err.message}`);
                        booking.createdBy = { name: 'Unknown' };
                    }
                }
                return booking;
            })
        );

        // Format response
        res.status(200).json({
            success: true,
            data: {
                bookings: populatedBookings,
                pagination: {
                    total,
                    page: parseInt(page, 10),
                    limit: parseInt(limit, 10),
                    totalPages: Math.ceil(total / parseInt(limit, 10))
                }
            }
        });

    } catch (error) {
        console.error('Error in getBookingsForShowroomStaff:', error);
        const statusCode = error.name === 'ValidationError' ? 400 : 500;
        res.status(statusCode).json({
            success: false,
            message: 'Error processing bookings request',
            error: process.env.NODE_ENV === 'development'
                ? error.message
                : 'Internal server error'
        });
    }
};

// Controller for cancel booking
exports.cancelBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const cancelData = req.body;

        if (!cancelData.cancelReason || !cancelData.cancelKm) {
            return res.status(400).json({
                message: 'All fields are required.',
                success: false
            });
        }

        if (!req.file && !req.file.filename) {
            return res.status(400).json({
                message: 'Please upload image',
                success: false
            });
        }

        const image = req.file.filename

        const booking = await Booking.findById(id);

        if (!booking) {
            return res.status(404).json({
                message: 'Booking not found',
                success: false
            });
        }

        if (booking.cancelStatus) {
            return res.status(409).json({
                message: 'This booking is already canceled',
                success: false
            });
        }

        booking.cancelImage = image;
        booking.cancelStatus = true;
        booking.cancelReason = cancelData.cancelReason;
        booking.status = "Order Completed"
        booking.cancelKm = cancelData.cancelKm;

        await booking.save();

        return res.status(200).json({
            message: "Booking Canceled.",
            success: true,
            booking
        });

    } catch (error) {
        console.log(error)
        return res.status(500).json({ message: "Internal server error" })
    }
}
// Controller for inventory booking
exports.inventoryBooking = async (req, res) => {
    try {
        const { id } = req.params;

        if (!req.file || !req.file.filename) {
            return res.status(400).json({
                message: 'Please upload an image.',
                success: false
            });
        }

        const image = req.file.filename;

        const booking = await Booking.findById(id);

        if (!booking) {
            return res.status(404).json({
                message: 'Booking not found.',
                success: false
            });
        }

        booking.inventoryImage = image;
        await booking.save();

        return res.status(200).json({
            message: 'Inventory image added.',
            success: true,
            booking
        });

    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
