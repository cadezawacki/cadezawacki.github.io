

function post_click_event_handler(){
    alert("You cliked on a post.")
}


function on_doc_ready(){
    $(".post").click(post_click_event_handler)
}

$(document).ready(on_doc_ready)