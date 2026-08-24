const CARD_GROUPS = [
  {
    key: 'pets-farm', en: 'Pets & Farm', zh: '宠物与农场', words: [
      ['cat', '猫'], ['dog', '狗'], ['rabbit', '兔子'], ['horse', '马'],
      ['cow', '奶牛'], ['sheep', '绵羊'], ['pig', '猪'], ['chicken', '小鸡']
    ]
  },
  {
    key: 'wild-animals', en: 'Wild Animals', zh: '野生动物', words: [
      ['lion', '狮子'], ['elephant', '大象'], ['giraffe', '长颈鹿'], ['monkey', '猴子'],
      ['panda', '熊猫'], ['bear', '熊'], ['fox', '狐狸'], ['deer', '鹿']
    ]
  },
  {
    key: 'small-creatures', en: 'Small Creatures', zh: '小生物', words: [
      ['butterfly', '蝴蝶'], ['bee', '蜜蜂'], ['ladybug', '瓢虫'], ['ant', '蚂蚁'],
      ['frog', '青蛙'], ['turtle', '乌龟'], ['snail', '蜗牛'], ['fish', '鱼']
    ]
  },
  {
    key: 'people', en: 'People', zh: '人物', words: [
      ['boy', '男孩'], ['girl', '女孩'], ['baby', '婴儿'], ['mother', '妈妈'],
      ['father', '爸爸'], ['friend', '朋友'], ['teacher', '老师'], ['doctor', '医生']
    ]
  },
  {
    key: 'fantasy', en: 'Fantasy', zh: '幻想角色', words: [
      ['princess', '公主'], ['prince', '王子'], ['knight', '骑士'], ['fairy', '仙子'],
      ['wizard', '魔法师'], ['dragon', '龙'], ['pirate', '海盗'], ['robot', '机器人']
    ]
  },
  {
    key: 'vehicles', en: 'Vehicles', zh: '交通工具', words: [
      ['car', '汽车'], ['bus', '公交车'], ['train', '火车'], ['airplane', '飞机'],
      ['boat', '小船'], ['bicycle', '自行车'], ['tractor', '拖拉机'], ['rocket', '火箭']
    ]
  },
  {
    key: 'places', en: 'Places', zh: '地点', words: [
      ['home', '家'], ['school', '学校'], ['park', '公园'], ['farm', '农场'],
      ['forest', '森林'], ['beach', '海滩'], ['castle', '城堡'], ['space', '太空']
    ]
  },
  {
    key: 'nature-weather', en: 'Nature & Weather', zh: '自然与天气', words: [
      ['sun', '太阳'], ['moon', '月亮'], ['star', '星星'], ['cloud', '云'],
      ['rain', '雨'], ['snow', '雪'], ['wind', '风'], ['rainbow', '彩虹']
    ]
  },
  {
    key: 'food', en: 'Food', zh: '食物', words: [
      ['apple', '苹果'], ['banana', '香蕉'], ['orange', '橙子'], ['strawberry', '草莓'],
      ['watermelon', '西瓜'], ['carrot', '胡萝卜'], ['cake', '蛋糕'], ['bread', '面包']
    ]
  },
  {
    key: 'home-objects', en: 'Home Objects', zh: '家居物品', words: [
      ['bed', '床'], ['chair', '椅子'], ['table', '桌子'], ['door', '门'],
      ['window', '窗户'], ['lamp', '台灯'], ['clock', '时钟'], ['key', '钥匙']
    ]
  },
  {
    key: 'toys-play', en: 'Toys & Play', zh: '玩具与游戏', words: [
      ['ball', '球'], ['kite', '风筝'], ['doll', '玩偶'], ['blocks', '积木'],
      ['puzzle', '拼图'], ['drum', '鼓'], ['swing', '秋千'], ['slide', '滑梯']
    ]
  },
  {
    key: 'clothing', en: 'Clothing', zh: '服装', words: [
      ['hat', '帽子'], ['shoes', '鞋子'], ['coat', '外套'], ['dress', '连衣裙'],
      ['shirt', '衬衫'], ['pants', '裤子'], ['scarf', '围巾'], ['boots', '靴子']
    ]
  },
  {
    key: 'actions', en: 'Actions', zh: '动作', words: [
      ['run', '跑'], ['jump', '跳'], ['swim', '游泳'], ['fly', '飞'],
      ['dance', '跳舞'], ['sing', '唱歌'], ['read', '阅读'], ['help', '帮助']
    ]
  },
  {
    key: 'feelings', en: 'Feelings & Traits', zh: '情绪与品质', words: [
      ['happy', '开心'], ['sad', '难过'], ['brave', '勇敢'], ['kind', '善良'],
      ['curious', '好奇'], ['sleepy', '困倦'], ['excited', '兴奋'], ['surprised', '惊讶']
    ]
  },
  {
    key: 'colors-shapes', en: 'Colors & Shapes', zh: '颜色与形状', words: [
      ['red', '红色'], ['blue', '蓝色'], ['yellow', '黄色'], ['green', '绿色'],
      ['circle', '圆形'], ['square', '正方形'], ['triangle', '三角形'], ['heart', '爱心']
    ]
  },
  {
    key: 'story-world', en: 'Story World', zh: '冒险元素', words: [
      ['treasure', '宝藏'], ['map', '地图'], ['letter', '信'], ['gift', '礼物'],
      ['music', '音乐'], ['garden', '花园'], ['river', '河流'], ['mountain', '高山']
    ]
  }
];

export const CARD_CATEGORIES = Object.freeze(CARD_GROUPS.map(({ key, en, zh }) =>
  Object.freeze({ key, en, zh })
));

export const CARD_CATALOG = Object.freeze(CARD_GROUPS.flatMap((group, groupIndex) =>
  group.words.map(([en, zh], wordIndex) => Object.freeze({
    id: `C${String(groupIndex * 8 + wordIndex + 1).padStart(3, '0')}`,
    en,
    zh,
    category: group.key
  }))
));

if (CARD_CATALOG.length !== 128) {
  throw new Error(`Card catalog must contain exactly 128 cards; found ${CARD_CATALOG.length}`);
}

const cardsById = new Map(CARD_CATALOG.map((card) => [card.id, card]));

export function getCardById(id) {
  return cardsById.get(String(id).toUpperCase());
}
