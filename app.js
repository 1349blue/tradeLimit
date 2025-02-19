// Đăng ký Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/sw.js')
            .then((registration) => {
                console.log('Service Worker đã được đăng ký với phạm vi:', registration.scope);
            })
            .catch((error) => {
                console.error('Đăng ký Service Worker thất bại:', error);
            });
    });
}

// Phần OKXApi class
class OKXApi {
    constructor(apiKey, secretKey, passphrase, isTestnet = false) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.passphrase = passphrase;
        this.baseUrl = isTestnet ? 'https://www.okx.com' : 'https://www.okx.com';
    }

    async createSignature(timestamp, method, path, body = '') {
        const message = `${timestamp}${method}${path}${body}`;
        const encoder = new TextEncoder();
        const key = encoder.encode(this.secretKey);
        const data = encoder.encode(message);

        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            key,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        const signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
        return btoa(String.fromCharCode(...new Uint8Array(signature)));
    }

    async getHeaders(method, path, body = '') {
        const timestamp = new Date().toISOString();
        const signature = await this.createSignature(timestamp, method, path, body);

        return {
            'Content-Type': 'application/json',
            'OK-ACCESS-KEY': this.apiKey,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': this.passphrase
        };
    }

    async executeOrder(token, side, size, ordType, price = null, tgtCcy) {
        try {
            const path = '/api/v5/trade/order';
            const body = JSON.stringify({
                instId: `${token}-USDT`,
                tdMode: 'cash',
                side: side,
                ordType: ordType,
                sz: size,
                tgtCcy: tgtCcy,
                ...(ordType === 'limit' && { px: price })
            });

            const headers = await this.getHeaders('POST', path, body);

            const response = await fetch(this.baseUrl + path, {
                method: 'POST',
                headers,
                body
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            if (result.code === '0') {
                return result.data[0];
            }
            throw new Error(`Order execution failed: ${result.msg}`);
        } catch (error) {
            console.error('Error executing order:', error);
            throw error;
        }
    }
    async tradeSpot(token, action, sizeOrPercentage, isPercentage = false, ordType = 'market', price = null, tgtCcy = 'base_ccy') {
        try {
            let sizeToTrade;

            if (isPercentage) {
                // Kiểm tra dữ liệu đầu vào
                if (!token || !action || isNaN(sizeOrPercentage) || sizeOrPercentage <= 0 || sizeOrPercentage > 100) {
                    console.error("Dữ liệu nhập không hợp lệ.");
                    return;
                }

                // Lấy số dư hiện tại của token
                const balance = await this.getTokenBalance(token);

                if (balance > 0) {
                    // Tính toán số lượng cần giao dịch
                    sizeToTrade = balance * (sizeOrPercentage / 100);
                } else {
                    console.log(`No ${token} balance available to ${action}.`);
                    return;
                }
            } else {
                sizeToTrade = sizeOrPercentage;
            }

            // Thực hiện lệnh
            const side = action.toLowerCase(); // Mua hoặc bán
            const orderResult = await this.executeOrder(token, side, sizeToTrade, ordType, price, tgtCcy);
            console.log(`${ordType.charAt(0).toUpperCase() + ordType.slice(1)} order placed successfully:`, orderResult);
            return orderResult;
        } catch (error) {
            console.error(`Error placing ${ordType} order:`, error);
            throw error;
        }
    }

    async getCurrentPrice(tokenNameTarget) {
        try {
            const url = `https://www.okx.com/api/v5/market/ticker?instId=${tokenNameTarget}-USDT`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            return parseFloat(data.data[0].last);
        } catch (error) {
            console.error('Error fetching current price:', error);
            throw error;
        }
    }

    // Thêm hàm getTokenBalance
    async getTokenBalance(token) {
        try {
            const path = '/api/v5/account/balance';
            const headers = await this.getHeaders('GET', path);

            const response = await fetch(this.baseUrl + path, {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            if (result.code === '0') {
                // Tìm token trong danh sách
                const details = result.data[0]?.details || [];
                const tokenBalance = details.find(item => item.ccy === token);
                
                if (tokenBalance) {
                    // availBal: số dư khả dụng
                    // frozenBal: số dư đang bị khóa (trong lệnh chờ)
                    return {
                        available: parseFloat(tokenBalance.availBal),
                        frozen: parseFloat(tokenBalance.frozenBal),
                        total: parseFloat(tokenBalance.cashBal)
                    };
                } else {
                    console.log(`Không tìm thấy số dư của token ${token}`);
                    return {
                        available: 0,
                        frozen: 0,
                        total: 0
                    };
                }
            }
            throw new Error(`Failed to get balance: ${result.msg}`);
        } catch (error) {
            console.error('Error getting token balance:', error);
            throw error;
        }
    }

    // Thêm hàm helper để lấy số dư khả dụng
    async getAvailableBalance(token) {
        try {
            const balance = await this.getTokenBalance(token);
            return balance.available;
        } catch (error) {
            console.error('Error getting available balance:', error);
            throw error;
        }
    }
}

// Thêm vào đầu file app.js
class TempleTrade {
    constructor(okxApi) {
        this.okxApi = okxApi;
        this.lastTradePrice = 0;
        this.lastTradeType = null;
    }
    // Thêm hàm mua ngay lập tức với giá thị trường
    async instantMarketBuy(token, amount) {
        
        if (amount <= 0) {
            console.error('Số lượng phải lớn hơn 0 để thực hiện lệnh bán.');
            return {
                success: false,
                error: 'Số lượng không hợp lệ'
            };
        }
        try {
            const result = await this.okxApi.tradeSpot(
                token,          // Token muốn giao dịch (ví dụ: 'BTC')
                'buy',          // Hành động: mua
                amount,         // Số lượng: 10
                false,          // isPercentage: false (số lượng cụ thể, không phải phần trăm)
                'market',       // ordType: market (lệnh thị trường)
                null,           // price: null (không cần giá cho lệnh thị trường)
                'base_ccy'      // tgtCcy: base_ccy (đơn vị là token gốc)
            );

            if (result) {
                soundManager.playOrderSound();
                this.lastTradePrice = result.fillPx;
                this.lastTradeType = 'buy';
                console.log(`Đã mua thành công ${amount} ${token} với giá thị trường`);
                return {
                    success: true,
                    price: result.fillPx,
                    amount: result.fillSz,
                    orderId: result.ordId
                };
            }
        } catch (error) {
            soundManager.playErrorSound();
            console.error('Lỗi khi thực hiện lệnh mua ngay:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Thêm hàm bán ngay lập tức với giá thị trường
    async instantMarketSell(token, amount) {
        if (amount <= 0) {
            console.error('Số lượng phải lớn hơn 0 để thực hiện lệnh bán.');
            return {
                success: false,
                error: 'Số lượng không hợp lệ'
            };
        }

        try {
            const result = await this.okxApi.tradeSpot(
                token,          // Token muốn giao dịch (ví dụ: 'BTC')
                'sell',         // Hành động: bán
                amount,         // Số lượng token cần bán
                false,          // isPercentage: false (số lượng cụ thể, không phải phần trăm)
                'market',       // ordType: market (lệnh thị trường)
                null,           // price: null (không cần giá cho lệnh thị trường)
                'base_ccy'      // tgtCcy: base_ccy (đơn vị là token gốc)
            );

            if (result) {
                soundManager.playOrderSound();
                this.lastTradePrice = result.fillPx;
                this.lastTradeType = 'sell';
                console.log(`Đã bán thành công ${amount} ${token} với giá thị trường`);
                return {
                    success: true,
                    price: result.fillPx,
                    amount: result.fillSz,
                    orderId: result.ordId
                };
            }
        } catch (error) {
            soundManager.playErrorSound();
            console.error('Lỗi khi thực hiện lệnh bán ngay:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Phần OrderControl class
class OrderControl {
    constructor() {
        this.okxApi = new OKXApi();
        this.orderMatrix = [];
        this.templeTrade = new TempleTrade(this.okxApi);
        this.params_advanced = null;
        this.intervalId = null;
        this.config = {
            tokenName: '',
            tradeBias: 0.5,
            tradeLimit: 0.5,
            totalAmount: 0,
            logic: 0,
            maxMatrixSize: 5,
            priceDeviation: 1.5,
            upperPriceLimit: 0,
            lowerPriceLimit: 0
        };
        this.tradeHistory = [];
    }

    setupConfig(params) {
        const {
            tokenName = 'BTC',
            tradeBias = 0.5,
            tradeLimit = 0.5,
            totalAmount = 0,
            logic = 0,
            maxMatrixSize = 5,
            priceDeviation = 1.5,
            upperPriceLimit = 0,
            lowerPriceLimit = 0
        } = params;

        this.config = {
            tokenName,
            tradeBias,
            tradeLimit,
            totalAmount,
            logic,
            maxMatrixSize,
            priceDeviation,
            upperPriceLimit,
            lowerPriceLimit
        };

        this.setupTradePairs();
        
        console.log('Đã cập nhật cấu hình:', this.config);
        return this.config;
    }

    async setupTradePairs() {
        try {
            const currentPrice = await this.okxApi.getCurrentPrice(this.config.tokenName);
            const buyPriceLimit = currentPrice * (1 + this.config.tradeLimit / 100);
            const sellPriceLimit = buyPriceLimit * (1 + this.config.tradeBias / 100);
            this.config.logic = -1;
            this.params_advanced = {
                currentPrice: currentPrice,
                sellPrice: sellPriceLimit,
                buyPrice: buyPriceLimit,
                d_b: -1,
                a_b: 1,
                d_m: -1,
                a_m: 1,
                enumStatus: 1
            };
            return this.params_advanced;
        } catch (error) {
            logger.error('Lỗi khi thiết lập giá:', error);
            throw error;
        }
    }

    async executeAdvancedTrading(params) {
        const {
            currentPrice,
            sellPrice,
            buyPrice,
            d_b = 1,
            a_b = -1,
            d_m = 1,
            a_m = -1,
            enumStatus = 0
        } = params;

        let newD_b = d_b;
        let newA_b = a_b;
        let newD_m = d_m;
        let newA_m = a_m;
        let newEnumStatus = enumStatus;

        try {
            if (currentPrice < sellPrice && newD_b > 0) {
                newEnumStatus = 1;
                newD_b = -1;
                newA_b = 1;

                this.config.logic = 0; // chú ý dòng này logic = 0  để xem xét đã đủ điều kiện tạo lệnh params_advanced mới chưa
                
                //this.config.logic = -1; 
                //this.params_advanced.buyPrice = currentPrice * (1 + this.config.tradeLimit / 100);
                //this.params_advanced.sellPrice = this.params_advanced.buyPrice*(1 + this.config.tradeBias/100);

                const availableBalance = await this.okxApi.getAvailableBalance(this.config.tokenName); 
                if (availableBalance < this.config.totalAmount) {
                    await this.templeTrade.instantMarketSell(this.config.tokenName, availableBalance);
                    this.addTradeHistory(
                        'Bán (Limit)',
                        sellPrice,
                        availableBalance,
                        'Thành công'
                    );
                } else {
                    await this.templeTrade.instantMarketSell(this.config.tokenName, this.config.totalAmount);
                    this.addTradeHistory(
                        'Bán (Limit)',
                        sellPrice,
                        this.config.totalAmount,
                        'Thành công'
                    );
                }
            }
            
            if (currentPrice > sellPrice && newA_b > 0) {
                newD_b = 1;
                newA_b = -1;
            }
            
            if (currentPrice < buyPrice && newD_m > 0) {
                newD_m = -1;
                newA_m = 1;
            }
            
            if (newEnumStatus === 1 && currentPrice > buyPrice && newA_m > 0) {
                newEnumStatus = 0;
                newD_m = 1;
                newA_m = -1;
                await this.templeTrade.instantMarketBuy(this.config.tokenName, this.config.totalAmount);
                this.config.logic = 1;
                this.addTradeHistory(
                    'Mua (Limit)',
                    buyPrice,
                    this.config.totalAmount,
                    'Thành công'
                );
            }

            return {
                d_b: newD_b,
                a_b: newA_b,
                d_m: newD_m,
                a_m: newA_m,
                enumStatus: newEnumStatus
            };

        } catch (error) {
            console.error('Lỗi khi thực hiện giao dịch:', error);
            throw error;
        }
    }
       
    
    // Thêm hàm xóa lệnh đã hoàn thành và trả về giá thấp nhất
    cleanCompletedOrders() {
        let lowestPrice = Infinity;
        this.orderMatrix = this.orderMatrix.filter(order => {
            if (order.logic !== 0) {
                if (order.sellPrice < lowestPrice) {
                    lowestPrice = order.sellPrice;
                }
                return true;
            }
            return false;
        });
        return lowestPrice;
    }

    // Thêm hàm kiểm tra và cập nhật giá limit
    async checkLimitExecuteOrders() {
        try {
            const currentPrice = await this.okxApi.getCurrentPrice(this.config.tokenName);
            
            // Kiểm tra giới hạn giá
            // Nếu giá không nằm trong giới hạn (isPriceWithinLimits trả về false) thì thoát khỏi hàm
            if (!this.isPriceWithinLimits(currentPrice)) {
                return; // Thoát khỏi hàm nếu giá nằm ngoài giới hạn
            }
            
            // Xử lý orderMatrix
            for (let order of this.orderMatrix) {
                if (currentPrice < order.sellPrice && order.logic === 1) {
                    try {
                        const availableBalance = await this.okxApi.getAvailableBalance(this.config.tokenName); 
                        if (availableBalance < this.config.totalAmount) {
                            await this.templeTrade.instantMarketSell(this.config.tokenName, availableBalance);
                            this.addTradeHistory(
                                'Bán(waited)',
                                order.sellPrice,
                                availableBalance,
                                'Thành công'
                            );
                        } else {
                            await this.templeTrade.instantMarketSell(this.config.tokenName, this.config.totalAmount);
                            this.addTradeHistory(
                                'Bán(waited)',
                                order.sellPrice,
                                this.config.totalAmount,
                                'Thành công'
                            );
                        }
                        order.logic = 0;                      
                    } catch (error) {
                        logger.error('Lỗi khi thực hiện lệnh bán:', error);
                    }
                } else if (currentPrice*(1-this.config.tradeLimit/100) > order.sellPrice && order.logic === 1) {
                    order.sellPrice = currentPrice*(1-this.config.tradeLimit/100);
                } else if (currentPrice > order.sellPrice && order.logic === -1) {
                    order.logic = 1; // Chuyển sang trạng thái chờ bán
                    logger.info(`Đã chuyển lệnh sang trạng thái chờ bán tại giá: ${order.sellPrice}`);
                }
            }

            // Xóa các lệnh đã hoàn thành và lấy giá thấp nhất
            const lowestPrice = this.cleanCompletedOrders();
            if (this.config.logic === 0) {
                    if (lowestPrice === Infinity || currentPrice < lowestPrice * (1 - this.config.priceDeviation / 100)) {
                        await this.setupTradePairs();
                    }
            } else {

            //update this.params_advanced
            // this.config.logic ở đây để chuyển qua lại giới hạn lệnh bán và mua
                if (this.config.logic === -1 && this.params_advanced.buyPrice > currentPrice*(1+this.config.tradeLimit/100)) { // Chỉ xử lý các lệnh đang chờ mua
                    // Tính giá limit mới
                    this.params_advanced.buyPrice = currentPrice * (1 + this.config.tradeLimit / 100);
                    this.params_advanced.sellPrice = this.params_advanced.buyPrice*(1 + this.config.tradeBias/100);                   
                    
                } else if (this.config.logic === 1 && this.params_advanced.sellPrice < currentPrice*(1-this.config.tradeLimit/100)) { // Chỉ xử lý các lệnh đang chờ bán
                    // Tính giá limit mới
                    this.params_advanced.sellPrice = currentPrice * (1 - this.config.tradeLimit / 100);
                    this.params_advanced.buyPrice = this.params_advanced.sellPrice*(1 - this.config.tradeBias/100);                   
                }
                          
            // Cập nhật giá hiện tại
            this.params_advanced.currentPrice = currentPrice;   
            
            // Thực hiện giao dịch nâng cao và cập nhật params_advanced
            const newParams = await this.executeAdvancedTrading(this.params_advanced);
            if (newParams) {
                this.params_advanced = {
                    ...this.params_advanced,
                    d_b: newParams.d_b,
                    a_b: newParams.a_b,
                    d_m: newParams.d_m,
                    a_m: newParams.a_m,
                    enumStatus: newParams.enumStatus
                };
            }

            // Kiểm tra điều kiện để thêm params_advanced mới vào orderMatrix
            if (this.params_advanced.enumStatus === 0 && this.orderMatrix.length < this.config.maxMatrixSize && (currentPrice < this.params_advanced.buyPrice * (1 - this.config.priceDeviation / 100))) {
                
                const sellAdd = this.params_advanced.sellPrice;
                this.orderMatrix.push({
                    sellPrice: sellAdd,
                    logic: -1,
                });
                logger.info(`Thêm lệnh mới tại giá bán: ${sellAdd}`);
                await this.setupTradePairs();
            }
            
            // Cập nhật giá hiện tại
            //this.params_advanced.currentPrice = currentPrice;
        }
            
        } catch (error) {
            logger.error('Lỗi khi kiểm tra và cập nhật giá limit:', error);
            throw error;
        }
    }

    async startTrading() {
        if (this.intervalId) {
            logger.warning('Hệ thống đang giao dịch');
            return;
        }

        try {
            // Khởi tạo giá ban đầu
            await this.setupTradePairs();
            
            this.intervalId = setInterval(async () => {
                try {
                    await this.checkLimitExecuteOrders();
                } catch (error) {
                    logger.error('Lỗi trong quá trình giao dịch:', error);
                }
            }, 1000);

            logger.success('Đã bắt đầu giao dịch');
        } catch (error) {
            logger.error('Lỗi khi khởi động giao dịch:', error);
        }
    }

    stopTrading() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
    addTradeHistory(type, price, amount, status) {
        const trade = {
            time: new Date().toLocaleString(),
            type: type,
            price: price,
            amount: amount,
            status: status
        };
        this.tradeHistory.unshift(trade);
        if (this.tradeHistory.length > 100) {
            this.tradeHistory.pop();
        }
    }

    clearTradeHistory() {
        this.tradeHistory = [];
    }

    // Thêm vào class OrderControl
    clearOrderMatrix() {
        this.orderMatrix = [];
        logger.info('Đã xóa toàn bộ ma trận lệnh');
    }

    // Thêm hàm kiểm tra giới hạn giá
    isPriceWithinLimits(price) {
        const { upperPriceLimit, lowerPriceLimit } = this.config;
        
        // Nếu cả hai giới hạn đều là 0, không áp dụng giới hạn
        if (upperPriceLimit === 0 && lowerPriceLimit === 0) {
            return true;
        }

        // Kiểm tra giới hạn trên (nếu có)
        if (upperPriceLimit > 0 && price > upperPriceLimit) {
            logger.warning(`Giá ${price} vượt quá giới hạn trên ${upperPriceLimit}`);
            return false;
        }

        // Kiểm tra giới hạn dưới (nếu có)
        if (lowerPriceLimit > 0 && price < lowerPriceLimit) {
            logger.warning(`Giá ${price} thấp hơn giới hạn dưới ${lowerPriceLimit}`);
            return false;
        }

        return true;
    }
}

// Khởi tạo OrderControl
const orderControl = new OrderControl();

// Thêm vào phần đầu file, sau khai báo các class
const logger = {
    container: null,
    maxEntries: 1000,

    init() {
        this.container = document.getElementById('logContainer');
    },

    log(message, type = 'info') {
        if (!this.container) return;

        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        
        const timestamp = document.createElement('span');
        timestamp.className = 'log-timestamp';
        timestamp.textContent = new Date().toLocaleTimeString();
        
        entry.appendChild(timestamp);
        entry.appendChild(document.createTextNode(message));
        
        this.container.insertBefore(entry, this.container.firstChild);
        
        // Giới hạn số lượng log entries
        while (this.container.children.length > this.maxEntries) {
            this.container.removeChild(this.container.lastChild);
        }

        // Tự động cuộn xuống
        this.container.scrollTop = 0;
    },

    clear() {
        if (this.container) {
            this.container.innerHTML = '';
        }
    },

    info(message) {
        this.log(message, 'info');
    },

    success(message) {
        this.log(message, 'success');
    },

    error(message) {
        this.log(message, 'error');
    },

    warning(message) {
        this.log(message, 'warning');
    }
};

// Thêm vào đầu file, sau khai báo logger
const soundManager = {
    audioContext: null,
    
    init() {
        // Khởi tạo audio context khi người dùng tương tác
        document.addEventListener('click', () => {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
        }, { once: true });
    },

    playBeep(frequency = 440, duration = 200, type = 'sine', volume = 0.1) {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        
        // Tạo fade in/out để tránh click sound
        gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(volume, this.audioContext.currentTime + 0.01);
        gainNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + duration / 1000);
        
        oscillator.start();
        oscillator.stop(this.audioContext.currentTime + duration / 1000);
    },

    playOrderSound() {
        // Âm thanh thành công: 2 beep cao, ngắn
        this.playBeep(880, 100, 'sine', 0.1); // Beep 1
        setTimeout(() => {
            this.playBeep(1100, 100, 'sine', 0.1); // Beep 2
        }, 150);
    },

    playErrorSound() {
        // Âm thanh lỗi: 1 beep thấp, dài
        this.playBeep(220, 300, 'square', 0.1);
    }
};

// Phần script chính
document.addEventListener('DOMContentLoaded', () => {
    // Các elements
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const tradingStatus = document.getElementById('tradingStatus');
    const orderMatrixTable = document.getElementById('orderMatrix');

    // Hàm lấy giá trị từ form
    function getFormValues() {
        return {
            tokenName: document.getElementById('tokenName').value,
            tradeBias: parseFloat(document.getElementById('tradeBias').value),
            tradeLimit: parseFloat(document.getElementById('tradeLimit').value),
            totalAmount: parseFloat(document.getElementById('totalAmount').value),
            maxMatrixSize: parseInt(document.getElementById('maxMatrixSize').value),
            priceDeviation: parseFloat(document.getElementById('priceDeviation').value),
            upperPriceLimit: parseFloat(document.getElementById('upperPriceLimit').value),
            lowerPriceLimit: parseFloat(document.getElementById('lowerPriceLimit').value),
            logic: 0
        };
    }

    // Hàm cập nhật bảng ma trận lệnh
    function updateOrderMatrix(orderMatrix) {
        const tbody = document.querySelector('#orderMatrix tbody');
        tbody.innerHTML = '';

        orderMatrix.forEach((order, index) => {
            const row = document.createElement('tr');
            let statusClass, statusText;
            
            switch(order.logic) {
                case 0:
                    statusClass = 'status-completed';
                    statusText = 'Đã bán';
                    break;
                case 1:
                    statusClass = 'status-ready';
                    statusText = 'Chờ bán';
                    break;
                case -1:
                    statusClass = 'status-waiting';
                    statusText = 'Chờ kích hoạt';
                    break;
            }
            
            row.innerHTML = `
                <td>${index + 1}</td>
                <td>${order.sellPrice.toFixed(6)}</td>
                <td class="${statusClass}">${statusText}</td>
            `;
            tbody.appendChild(row);
        });
    }

    // Thêm hàm cập nhật params_advanced
    function updateParamsAdvanced(params) {
        if (params) {
            document.getElementById('currentPrice').textContent = params.currentPrice.toFixed(6);
            document.getElementById('sellPrice').textContent = params.sellPrice.toFixed(6);
            document.getElementById('buyPrice').textContent = params.buyPrice.toFixed(6);
            document.getElementById('enumStatus').textContent = params.enumStatus;
            document.getElementById('d_b').textContent = params.d_b;
            document.getElementById('a_b').textContent = params.a_b;
            document.getElementById('d_m').textContent = params.d_m;
            document.getElementById('a_m').textContent = params.a_m;
        }
    }

    // Thêm hàm cập nhật lịch sử
    function updateTradeHistory(history) {
        const tbody = document.querySelector('#tradeHistory tbody');
        tbody.innerHTML = '';

        history.forEach(trade => {
            const row = document.createElement('tr');
            const typeClass = trade.type.includes('Mua') ? 'trade-buy' : 'trade-sell';
            row.innerHTML = `
                <td>${trade.time}</td>
                <td class="${typeClass}">${trade.type}</td>
                <td>${trade.price.toFixed(6)}</td>
                <td>${trade.amount}</td>
                <td>${trade.status}</td>
            `;
            tbody.appendChild(row);
        });
    }

    // Xử lý sự kiện bắt đầu giao dịch
    startBtn.addEventListener('click', async () => {
        try {
            const config = getFormValues();
            
            // Cập nhật API keys
            orderControl.okxApi.apiKey = document.getElementById('apiKey').value;
            orderControl.okxApi.secretKey = document.getElementById('secretKey').value;
            orderControl.okxApi.passphrase = document.getElementById('passphrase').value;

            // Thiết lập cấu hình và bắt đầu giao dịch
            orderControl.setupConfig(config);
            await orderControl.startTrading();

            // Cập nhật UI
            tradingStatus.textContent = 'Trạng thái: Đang giao dịch';
            tradingStatus.className = 'status trading-active';
            updateParamsAdvanced(orderControl.params_advanced);
        } catch (error) {
            logger.error('Lỗi khi bắt đầu giao dịch:', error);
            tradingStatus.textContent = 'Trạng thái: Lỗi khi khởi động';
            tradingStatus.className = 'status trading-inactive';
        }
    });

    // Xử lý sự kiện dừng giao dịch
    stopBtn.addEventListener('click', () => {
        orderControl.stopTrading();
        tradingStatus.textContent = 'Trạng thái: Đã dừng giao dịch';
        tradingStatus.className = 'status trading-inactive';
    });

    // Thêm xử lý sự kiện cho nút xóa lịch sử
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    clearHistoryBtn.addEventListener('click', () => {
        orderControl.clearTradeHistory();
        updateTradeHistory(orderControl.tradeHistory);
    });

    // Cập nhật ma trận lệnh mỗi giây
    setInterval(() => {
        if (orderControl.params_advanced) {
            updateParamsAdvanced(orderControl.params_advanced);
            updateTradeHistory(orderControl.tradeHistory);
            updateOrderMatrix(orderControl.orderMatrix);
        }
    }, 1000);

    // Khởi tạo logger
    logger.init();

    // Thêm xử lý sự kiện cho nút xóa log
    const clearLogBtn = document.getElementById('clearLogBtn');
    clearLogBtn.addEventListener('click', () => {
        logger.clear();
    });

    // Cập nhật các console.log hiện tại để sử dụng logger
    // Ví dụ:
    console.log = function(message) {
        logger.info(message);
    };
    console.error = function(message) {
        logger.error(message);
    };
    console.warn = function(message) {
        logger.warning(message);
    };

    // Hàm lưu cấu hình
    function saveConfig() {
        const config = {
            api: {
                apiKey: document.getElementById('apiKey').value,
                secretKey: document.getElementById('secretKey').value,
                passphrase: document.getElementById('passphrase').value
            },
            trading: {
                tokenName: document.getElementById('tokenName').value,
                totalAmount: document.getElementById('totalAmount').value,
                maxMatrixSize: document.getElementById('maxMatrixSize').value,
                upperPriceLimit: document.getElementById('upperPriceLimit').value,
                lowerPriceLimit: document.getElementById('lowerPriceLimit').value
            },
            strategy: {
                tradeBias: document.getElementById('tradeBias').value,
                tradeLimit: document.getElementById('tradeLimit').value,
                priceDeviation: document.getElementById('priceDeviation').value
            },
            orderMatrix: orderControl.orderMatrix,
            params_advanced: orderControl.params_advanced
        };

        const tokenName = document.getElementById('tokenName').value || 'unknown';
        const currentDate = new Date().toISOString().slice(0,10);
        const fileName = `${tokenName}_config_${currentDate}.json`;

        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        logger.success(`Đã lưu cấu hình cho token ${tokenName} thành công`);
    }

    // Hàm tải cấu hình
    function loadConfig(file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const config = JSON.parse(e.target.result);
                
                // Áp dụng cấu hình API
                if (config.api) {
                    document.getElementById('apiKey').value = config.api.apiKey || '';
                    document.getElementById('secretKey').value = config.api.secretKey || '';
                    document.getElementById('passphrase').value = config.api.passphrase || '';
                }

                // Áp dụng cấu hình giao dịch
                if (config.trading) {
                    document.getElementById('tokenName').value = config.trading.tokenName || 'LINK';
                    document.getElementById('totalAmount').value = config.trading.totalAmount || '1';
                    document.getElementById('maxMatrixSize').value = config.trading.maxMatrixSize || '5';
                    document.getElementById('upperPriceLimit').value = config.trading.upperPriceLimit || '0';
                    document.getElementById('lowerPriceLimit').value = config.trading.lowerPriceLimit || '0';
                }

                // Áp dụng cấu hình chiến lược
                if (config.strategy) {
                    document.getElementById('tradeBias').value = config.strategy.tradeBias || '0.5';
                    document.getElementById('tradeLimit').value = config.strategy.tradeLimit || '0.5';
                    document.getElementById('priceDeviation').value = config.strategy.priceDeviation || '1.5';
                }

                // Khôi phục ma trận lệnh nếu có
                if (config.orderMatrix) {
                    orderControl.orderMatrix = config.orderMatrix;
                    updateOrderMatrix(orderControl.orderMatrix);
                    logger.info(`Đã khôi phục ${config.orderMatrix.length} lệnh từ file cấu hình`);
                }

                // Khôi phục params_advanced nếu có
                if (config.params_advanced) {
                    orderControl.params_advanced = config.params_advanced;
                    updateParamsAdvanced(orderControl.params_advanced);
                    logger.info('Đã khôi phục params_advanced từ file cấu hình');
                }

                logger.success('Đã tải cấu hình và ma trận lệnh thành công');
            } catch (error) {
                logger.error('Lỗi khi tải file cấu hình:', error);
            }
        };
        reader.readAsText(file);
    }

    // Xử lý sự kiện cho nút Save Config
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    saveConfigBtn.addEventListener('click', saveConfig);

    // Xử lý sự kiện cho nút Load Config
    const loadConfigBtn = document.getElementById('loadConfigBtn');
    const configFileInput = document.getElementById('configFileInput');
    
    loadConfigBtn.addEventListener('click', () => {
        configFileInput.click();
    });

    configFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            loadConfig(e.target.files[0]);
            e.target.value = ''; // Reset input
        }
    });

    // Xử lý sự kiện cho nút xóa ma trận
    const clearMatrixBtn = document.getElementById('clearMatrixBtn');
    clearMatrixBtn.addEventListener('click', () => {
            orderControl.clearOrderMatrix();
            updateOrderMatrix(orderControl.orderMatrix);
            logger.success('Đã xóa ma trận lệnh thành công');
    });
}); 