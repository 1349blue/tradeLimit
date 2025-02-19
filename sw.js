const CACHE_NAME = 'okx-trading-cache-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/app.js',
    '/style.css',
    '/manifest.json'
];

// Cài đặt Service Worker
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Đã mở cache');
                return cache.addAll(urlsToCache);
            })
            .catch((error) => {
                console.error('Lỗi khi cache files:', error);
            })
    );
});

// Kích hoạt Service Worker
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Xóa cache cũ:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Xử lý fetch requests
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // Trả về response từ cache nếu có
                if (response) {
                    return response;
                }

                // Clone request vì nó chỉ có thể sử dụng một lần
                const fetchRequest = event.request.clone();

                // Thực hiện request mới nếu không có trong cache
                return fetch(fetchRequest).then(
                    (response) => {
                        // Kiểm tra response có hợp lệ không
                        if(!response || response.status !== 200 || response.type !== 'basic') {
                            return response;
                        }

                        // Clone response vì nó chỉ có thể sử dụng một lần
                        const responseToCache = response.clone();

                        // Thêm response mới vào cache
                        caches.open(CACHE_NAME)
                            .then((cache) => {
                                cache.put(event.request, responseToCache);
                            });

                        return response;
                    }
                );
            })
            .catch((error) => {
                console.error('Lỗi khi fetch:', error);
                // Có thể trả về fallback page ở đây
            })
    );
});
