function goToLocation(button) {
    let element = button.querySelector('a');
    if (element) {
        let href = element.getAttribute('href');
        window.location.href = href;
    } else {
        button.classList.add("overlay"); 
        setTimeout(() => {
            button.classList.remove("overlay");
        }, 3000); 
    }
} 

function cardMap() {heroCards.map((heroCard, i) => {

    let cards = '';

    let location = '';
    if (heroCard.linkLocation==="only")  { 
        location = `<p><span class="chip">Portfoilo Only</span></p>`;
    } else {
        location =`
        <a class="primary ${heroCard.linkLocation==="new" ? "" : "down"}" target="${heroCard.linkLocation==="new" ? "_blank" : "_self"}" 
            href="${heroCard.link}">
            <span>${heroCard.linkLocation==="new" ? "View Case Study" : "Down on Page"}</span>
            <svg><use xlink:href="images/solid.svg#arrow-${heroCard.linkLocation==="new" ? "right" : "down"}"></use></svg>
        </a>`;
    }

    // Buttons

    cards += `
    
    <button onclick="goToLocation(this)" style="background-color: ${heroCard.colorBackground};" key=${i} class="card">
    ${heroCard.linkLocation==="only" ? `<div class="message"><p>Portfoilo</br> Only</p></div>` : ''}
        <img src="/images/card/${heroCard.img}" alt="${heroCard.title}" />
        <div class="content">
            <h3>${heroCard.title}</h3>
            <p><span style="color: ${heroCard.colorHighlight};" class="cardDetails">${heroCard.details}</span></p>
            ${location}
        </div>
    </button>
    `;


    let element = document.getElementById("hero");
    
    element.insertAdjacentHTML("beforeend", cards);
    
})};

let w = window.innerWidth;

if (w > 800) {
    cardMap();
    cardMap();
} else {
    cardMap();
}


  