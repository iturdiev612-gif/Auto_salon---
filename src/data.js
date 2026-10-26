const photos = {
  sedan: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=1100&q=85',
  black: 'https://images.unsplash.com/photo-1618843479313-40f8afb4b4d8?auto=format&fit=crop&w=1100&q=85',
  suv: 'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?auto=format&fit=crop&w=1100&q=85',
  sport: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1100&q=85',
  luxury: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1100&q=85',
  red: 'https://images.unsplash.com/photo-1503739183509-3c9c6e4c8d15?auto=format&fit=crop&w=1100&q=85',
};
const entries = [
  ['Toyota','Camry Comfort','Седан',2024,32500,'2.5 л · 203 л.с.','Серебристый',photos.sedan],
  ['Toyota','Camry Premium','Седан',2024,36900,'2.5 л · 203 л.с.','Чёрный',photos.black],
  ['Toyota','RAV4 Adventure','Кроссовер',2024,38400,'2.0 л · 171 л.с.','Серый',photos.suv],
  ['Toyota','Land Cruiser 300','Внедорожник',2023,112000,'3.5 л · 415 л.с.','Белый',photos.luxury],
  ['Toyota','Highlander Hybrid','Кроссовер',2024,58900,'2.5 л Hybrid · 243 л.с.','Синий',photos.suv],
  ['Mercedes-Benz','C-Class Avantgarde','Седан',2024,54500,'2.0 л · 204 л.с.','Серебристый',photos.black],
  ['Mercedes-Benz','E-Class Exclusive','Седан',2024,68900,'2.0 л · 258 л.с.','Чёрный',photos.luxury],
  ['Mercedes-Benz','GLC 300 4MATIC','Кроссовер',2023,74200,'2.0 л · 258 л.с.','Белый',photos.suv],
  ['Mercedes-Benz','GLE 450','Кроссовер',2024,103000,'3.0 л · 367 л.с.','Серый',photos.sport],
  ['Mercedes-Benz','G-Class G 500','Внедорожник',2023,178000,'3.0 л · 449 л.с.','Чёрный',photos.black],
  ['Honda','Civic Elegance','Седан',2024,27900,'1.5 л · 180 л.с.','Синий',photos.sedan],
  ['Honda','Accord Sport','Седан',2023,34800,'1.5 л · 192 л.с.','Красный',photos.red],
  ['Honda','CR-V Lifestyle','Кроссовер',2024,39800,'1.5 л · 190 л.с.','Белый',photos.suv],
  ['Honda','Pilot Touring','Внедорожник',2023,51200,'3.5 л · 285 л.с.','Серый',photos.luxury],
  ['Honda','ZR-V Advance','Кроссовер',2024,36500,'2.0 л · 158 л.с.','Красный',photos.sport],
  ['Lamborghini','Urus S','Кроссовер',2024,245000,'4.0 л · 666 л.с.','Жёлтый',photos.sport],
  ['Lamborghini','Urus Performante','Кроссовер',2024,278000,'4.0 л · 666 л.с.','Чёрный',photos.black],
  ['Lamborghini','Huracán EVO','Купе',2023,239000,'5.2 л · 640 л.с.','Оранжевый',photos.red],
  ['Lamborghini','Huracán Tecnica','Купе',2024,269000,'5.2 л · 640 л.с.','Зелёный',photos.luxury],
  ['Lamborghini','Revuelto','Купе',2024,608000,'6.5 л Hybrid · 1015 л.с.','Жёлтый',photos.sport],
];
export const seedCars = entries.map(([brand,model,type,year,price,engine,color,image],i)=>({id:i+1,brand,model,name:`${brand} ${model}`,type,year,price,engine,color,image,rating:[4.7,4.8,4.9,5][i%4],reviews:8+(i*7)%31,badge:i%5===0?'Хит продаж':i%5===1?'Новинка':i%5===2?'В наличии':i%5===3?'Премиум':'Спецпредложение',description:`${brand} ${model} ${year} года в отличном состоянии. Автомобиль прошёл полную техническую проверку, имеет прозрачную историю и готов к тест-драйву. Поможем с оформлением и доставкой.`}));
export const photoFallback = photos.sedan;
